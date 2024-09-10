const { default: axios } = require('axios');
const WebSocket = require('ws');
const { optionalLog, logWarning } = require('./logger');
const { logSuccess } = require('./logger');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const clientId = crypto.randomUUID();
const appVersion = require('../../package.json').version;

const comfyuiAxios = axios.create({
    baseURL: global.config.comfyui_url,
    timeout: 10000,
    headers: {
        'User-Agent': `ComfyUIMini/${appVersion}`
    }
});


async function queuePrompt(workflowPrompt, clientId) {
    const postContents = { 'prompt': workflowPrompt, client_id: clientId };

    const response = await comfyuiAxios.post('/prompt', postContents, {
        headers: {
            'Content-Type': 'application/json'
        }
    });

    return response.data;
}


async function getImage(filename, subfolder, type) {
    const params = new URLSearchParams({ filename, subfolder, type });

    try {
        const response = await comfyuiAxios.get(`/view?${params.toString()}`, { responseType: 'arraybuffer' });

        return response;
    } catch (err) {
        if (err.code === "ECONNREFUSED") {

            // Fallback if ComfyUI is unavailable
            if (type === "output") {
                const readFile = fs.readFileSync(path.join(global.config.output_dir, subfolder, filename));

                return {
                    data: readFile,
                    headers: {
                        'Content-Type': 'image/png',
                        'Content-Length': readFile.length
                    }
                };
            }
        }
    }
}

async function generateProxiedImageUrl(filename, subfolder, folderType) {
    const params = new URLSearchParams({ filename, subfolder, type: folderType });

    return `/comfyui/image?${params.toString()}`;
}

async function getHistory(promptId) {
    const response = await axios.get(`/history/${promptId}`);

    return response.data;
}

async function getQueue() {
    const response = await axios.get('/queue');

    return response.data;
}

async function getOutputImages(promptId) {
    const outputImages = {};

    const history = await getHistory(promptId);
    const historyOutputs = history[promptId].outputs;

    for (const nodeId in historyOutputs) {
        const nodeOutput = historyOutputs[nodeId];
        if (nodeOutput.images) {
            const imageUrls = await Promise.all(nodeOutput.images.map(async (image) => {
                return await generateProxiedImageUrl(image.filename, image.subfolder, image.type);
            }));
            outputImages[nodeId] = imageUrls;
        }
    }

    return outputImages;
}

function bufferIsText(buffer) {
    try {
        const text = buffer.toString('utf8');
        JSON.parse(text);
        return true;
    } catch (error) {
        return false;
    }
}

async function generateImage(workflowPrompt, wsClient) {
    const wsServer = new WebSocket(`${global.config.comfyui_ws_url}/ws?clientId=${clientId}`);

    wsServer.on('open', async () => {
        try {
            const promptData = await queuePrompt(workflowPrompt);
            const promptId = promptData.prompt_id;

            optionalLog(global.config.optional_log.queue_image, "Queued image.");

            const queueJson = await getQueue();
            let totalImages;

            if (queueJson["queue_running"][0] === undefined) {
                // Exact workflow was ran before and was cached by ComfyUI.
                const cachedImages = await getOutputImages(promptId);
                optionalLog(global.config.optional_log.generation_finish, "Using cached generation result.");

                wsClient.send(JSON.stringify({ type: 'completed', data: cachedImages }));
                
            } else {
                totalImages = queueJson["queue_running"][0][4].length;
            }

            wsClient.send(JSON.stringify({type: "total_images", data: totalImages}));

            wsServer.on('message', async (data) => {
                if (bufferIsText(data)) {
                    const message = JSON.parse(data.toString());

                    if (message.type === "status") {
                        if (message.data.status.exec_info.queue_remaining == 0) {
                            optionalLog(global.config.optional_log.generation_finish, "Image generation finished.");
                            wsServer.close();
                        }
                    } else if (message.type === "progress") {
                        wsClient.send(JSON.stringify(message));
                    }
                    
                } else {

                    // Handle image buffers like ComfyUI client
                    const imageType = data.readUInt32BE(0);
                    let imageMime;

                    switch (imageType) {
                        case 1:
                        default:
                            imageMime = 'image/jpeg'
                            break
                        case 2:
                            imageMime = 'image/png'
                    }

                    const imageBlob = data.slice(8);
                    const base64Image = imageBlob.toString('base64');

                    const jsonPayload = {
                        type: 'preview',
                        data: { image: base64Image, mimetype: imageMime }
                    };

                    wsClient.send(JSON.stringify(jsonPayload));
                }
            });

            wsServer.on('close', async () => {
                const outputImages = await getOutputImages(promptId);

                wsClient.send(JSON.stringify({ type: 'completed', data: outputImages }));
            });
        } catch (error) {
            if (error.code === "ERR_BAD_REQUEST") {
                wsClient.send(JSON.stringify({ type: 'error', message: "Bad Request error when sending workflow request. This can happen if you have disabled extensions that are required to run the workflow." }));
                return;
            }

            console.error("Unknown error when generating image:", error);
            wsClient.send(JSON.stringify({ type: 'error', message: "Unknown error when generating image. Check console for more information." }));
        }
    });

    wsServer.on('error', (error) => {
        if (error.code === "ECONNREFUSED") {
            logWarning(`Could not connect to ComfyUI when attempting to generate image: ${error}`);
            wsClient.send(JSON.stringify({ type: 'error', message: 'Could not connect to ComfyUI. Check console for more information.' }));
        } else {
            console.error("WebSocket error when generating image:", error);
            wsClient.send(JSON.stringify({ type: 'error', message: 'Unknown WebSocket error when generating image. Check console for more information.' }));
        }
    })

}

async function checkForComfyUI() {
    try {
        const responseCodeMeaning = {
            200: "ComfyUI is running."
        };

        const request = await comfyuiAxios.get('/');
        const status = request.status;

        logSuccess(`${status}: ${responseCodeMeaning[status] || "Unknown response."}`);
    } catch (err) {
        const errorCode = err.code;

        const errorMeaning = {
            "ECONNREFUSED": "Make sure ComfyUI is running and is accessible at the URL in the config.json file."
        }

        logWarning(`${errorCode}: ${errorMeaning[errorCode] || err}`)
    }
}

async function interruptGeneration() {
    const response = await axios.post('/interrupt');

    return response.data;
}

module.exports = {
    generateImage,
    getQueue,
    getHistory,
    checkForComfyUI,
    interruptGeneration,
    getImage
};