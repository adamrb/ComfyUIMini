import { WorkflowInstance } from '@shared/classes/Workflow';
import { NormalisedComfyInputInfo, ProcessedObjectInfo } from '@shared/types/ComfyObjectInfo';
import { InputOption, WorkflowMetadata, WorkflowWithMetadata } from '@shared/types/Workflow';

export class WorkflowEditor {
    containerElem: HTMLElement;
    titleInput: HTMLInputElement;
    descriptionInput: HTMLTextAreaElement;
    workflowObject: WorkflowInstance | null;
    private inputCount: number;
    private comfyInputsInfo: ProcessedObjectInfo | null;

    /**
     *
     * @param {HTMLElement} containerElem The container element in which all of the inputs will be renderered.
     * @param {WorkflowInstance | null} workflowObject The workflow object to render
     * @param {HTMLInputElement} titleInput The title input element.
     * @param {HTMLTextAreaElement} descriptionInput The description input element.
     */
    constructor(
        containerElem: HTMLElement,
        workflowObject: WorkflowInstance | null,
        titleInput: HTMLInputElement,
        descriptionInput: HTMLTextAreaElement
    ) {
        this.containerElem = containerElem;
        this.titleInput = titleInput;
        this.descriptionInput = descriptionInput;

        this.inputCount = 0;
        this.comfyInputsInfo = null;

        this.workflowObject = workflowObject;
    }

    ensureWorkflowObject(): asserts this is { workflowObject: WorkflowWithMetadata } {
        if (this.workflowObject === null) {
            throw new Error('Workflow object is null');
        }
    }

    /**
     * Renders the workflow inputs.
     */
    async renderWorkflow() {
        this.ensureWorkflowObject();
        this.inputCount = 0;

        const blankMetadata: WorkflowMetadata = {
            title: 'My Workflow',
            description: '',
            format_version: '2',
            input_options: [],
        };

        const jsonMetadata = this.workflowObject.metadata || blankMetadata;

        this.titleInput.removeAttribute('disabled');
        this.titleInput.value = jsonMetadata.title || 'My Workflow';

        this.descriptionInput.removeAttribute('disabled');
        this.descriptionInput.value = jsonMetadata.description || '';

        this.containerElem.innerHTML = '';
        await this.renderAllInputs();
    }

    /**
     * Loops through every node and renders each input.
     */
    async renderAllInputs() {
        this.ensureWorkflowObject();

        if (this.workflowObject.version !== undefined) {
            // for workflows not imported in api format
            return null;
        }

        const allUserInputOptions = this.workflowObject.getInputOptionsList();

        for (const userInputOptions of allUserInputOptions) {
            const comfyMetadataForInputType = await this.getComfyMetadataForInputType(
                userInputOptions.input_name_in_node,
                userInputOptions.node_id
            );

            if (!comfyMetadataForInputType) {
                continue;
            }

            const inputNode = this.workflowObject.getNode(userInputOptions.node_id);

            const defaultValue = inputNode.inputs[userInputOptions.input_name_in_node].toString();

            await this.renderInput(userInputOptions, comfyMetadataForInputType, defaultValue, inputNode.class_type);
        }

        this.startInputEventListeners();
    }

    /**
     * Gets the `/objectinfo` metadata for a given input id and node id.
     *
     * @param {string} inputType The type of input in the node. e.g. `seed`, `scheduler`, `ckpt_name`.
     * @param {string} nodeId The ID of the node in the workflow.
     * @returns {Promise<NormalisedComfyInputInfo | null>} The metadata for the input type.
     */
    async getComfyMetadataForInputType(inputType: string, nodeId: string): Promise<NormalisedComfyInputInfo | null> {
        this.ensureWorkflowObject();

        if (!this.comfyInputsInfo) {
            const comfyObjectMetadata = await fetch('/comfyui/inputsinfo');
            const comfyObjectMetadataJson: ProcessedObjectInfo = await comfyObjectMetadata.json();

            this.comfyInputsInfo = comfyObjectMetadataJson;
        }

        const nodeClassType = this.workflowObject.getNode(nodeId).class_type;

        const comfyInputNodeInfo = this.comfyInputsInfo[nodeClassType];

        if (!comfyInputNodeInfo) {
            return null;
        }

        const comfyInputTypeInfo = comfyInputNodeInfo[inputType];

        if (comfyInputTypeInfo) {
            return comfyInputTypeInfo;
        } else {
            return null;
        }
    }

    /**
     * Renders an input based off an input config.
     *
     */
    async renderInput(
        userInputOptions: InputOption,
        comfyInputTypeMetadata: NormalisedComfyInputInfo,
        defaultValue: string,
        nodeClass: string
    ) {
        this.inputCount += 1;

        const nodeId = userInputOptions.node_id;
        const inputNameInNode = userInputOptions.input_name_in_node;

        const inputTypeText = `[${nodeId}] ${nodeClass}: ${inputNameInNode}`;

        const inputTitle = userInputOptions.title || inputTypeText;

        const idPrefix = `${nodeId}-${inputNameInNode}`;

        const html = `
            <div class="input-item" data-node-id="${nodeId}" data-node-input-name="${inputNameInNode}">
                <div class="options-container">
                    <div class="input-top-container">
                        <span class="input-counter">${this.inputCount}.</span>
                        <div class="icon eye hide-input-button" id="hide-button-${idPrefix}"></div>
                        <span class="input-type-text">${inputTypeText}</span>
                    </div>
                    <label for="${idPrefix}-title">Title</label>
                    <input type="text" id="${idPrefix}-title" placeholder="${inputTitle}" value="${inputTitle}" class="workflow-input workflow-input-title">
                    ${this.renderDefaultValueInput(comfyInputTypeMetadata, idPrefix, defaultValue)}
                </div>
                <div class="move-arrows-container">
                    <span class="move-arrow-up">&#x25B2;</span>
                    <span class="move-arrow-down">&#x25BC;</span>
                </div>
            </div>
        `;

        this.containerElem.innerHTML += html;

        if (userInputOptions.disabled) {
            const hideButtonElement = this.containerElem.querySelector(`#hide-button-${idPrefix}`) as HTMLElement;

            if (!hideButtonElement) {
                return;
            }

            this.hideInput(hideButtonElement);
        }
    }

    /**
     * Renders a default value input for a input, differs based on input type.
     *
     * @param {NormalisedComfyInputInfo} inputConfig The config for the input.
     * @param {string} idPrefix The id prefix for each element in the input.
     * @returns {string} The rendered HTML for the default value input.
     */
    renderDefaultValueInput(inputConfig: NormalisedComfyInputInfo, idPrefix: string, defaultValue: string): string {
        const inputDefault = defaultValue ?? inputConfig.default ?? '';

        let inputHTML = `<label for="${idPrefix}-default">Default</label>`;

        switch (inputConfig.type) {
            case 'ARRAY':
                const optionsList = inputConfig.list;

                inputHTML += `<select id="${idPrefix}-default" class="workflow-input workflow-input-default">`;

                for (const option of optionsList) {
                    inputHTML += `<option value="${option}" ${inputDefault == option ? 'selected' : ''}>${option}</option>`;
                }

                inputHTML += '</select>';

                break;
            case 'INT':
            case 'FLOAT':
                inputHTML += `
                    <input type="number" id="${idPrefix}-default" placeholder="${inputDefault}" value="${inputDefault}" class="workflow-input workflow-input-default">
                `;
                break;
            case `STRING`:
            default:
                inputHTML += `<input type="text" id="${idPrefix}-default" placeholder="${inputDefault}" value="${inputDefault}" class="workflow-input workflow-input-default">`;
                break;
        }

        return inputHTML;
    }

    /**
     * Hides an input after the eye icon is clicked.
     *
     * @param {Element} hideButtonElement The hide button element.
     */
    hideInput(hideButtonElement: HTMLElement) {
        if (hideButtonElement.classList.contains('hide')) {
            hideButtonElement.classList.add('eye');
            hideButtonElement.classList.remove('hide');

            const inputOptionsContainer = hideButtonElement.closest('.input-item');

            if (!inputOptionsContainer) {
                return;
            }

            inputOptionsContainer.classList.remove('disabled');

            const subInputsForInput = inputOptionsContainer.querySelectorAll('input, select');
            subInputsForInput.forEach((element) => {
                element.removeAttribute('disabled');
            });
        } else {
            hideButtonElement.classList.remove('eye');
            hideButtonElement.classList.add('hide');

            const inputOptionsContainer = hideButtonElement.closest('.input-item');

            if (!inputOptionsContainer) {
                return;
            }

            inputOptionsContainer.classList.add('disabled');

            const subInputsForInput = inputOptionsContainer.querySelectorAll('input, select');
            subInputsForInput.forEach((element) => {
                element.setAttribute('disabled', 'disabled');
            });
        }
    }

    startInputEventListeners() {
        this.containerElem.addEventListener('click', (e) => {
            // @ts-ignore
            const targetHasClass = (className: string) => e.target.classList.contains(className);

            if (targetHasClass('move-arrow-up')) {
                // @ts-ignore
                moveUp(e.target.closest('.input-item'));
            } else if (targetHasClass('move-arrow-down')) {
                // @ts-ignore
                moveDown(e.target.closest('.input-item'));
            } else if (targetHasClass('hide-input-button')) {
                // @ts-ignore
                this.hideInput(e.target);
            }
        });
    }

    /**
     * Updates a workflow object with data from the inputs.
     *
     * @returns {object} The exported workflow object.
     */
    updateJsonWithUserInput(): WorkflowWithMetadata {
        this.ensureWorkflowObject();

        const inputOptionsList = [];

        const modifiedWorkflow = this.workflowObject.workflow;

        const allInputs = this.containerElem.querySelectorAll('.input-item');
        for (const inputContainer of allInputs) {
            const inputNodeId = inputContainer.getAttribute('data-node-id');
            if (!inputNodeId) {
                continue;
            }

            const inputNameInNode = inputContainer.getAttribute('data-node-input-name');
            if (!inputNameInNode) {
                continue;
            }

            let inputOptions: InputOption = {} as InputOption;
            inputOptions['node_id'] = inputNodeId;
            inputOptions['input_name_in_node'] = inputNameInNode;

            if (inputContainer.classList.contains('disabled')) {
                inputOptions['disabled'] = true;
                inputOptionsList.push(inputOptions);
                continue;
            }

            const inputTitleElement = inputContainer.querySelector('.workflow-input-title') as HTMLInputElement;

            if (!inputTitleElement) {
                alert(`Error while saving workflow, input title element not found for ${inputNameInNode}`);
                continue;
            }

            inputOptions['title'] = inputTitleElement.value;

            const defaultValueElement = inputContainer.querySelector('.workflow-input-default') as HTMLInputElement;

            if (!defaultValueElement) {
                alert(`Error while saving workflow, default value element not found for ${inputNameInNode}`);
                continue;
            }

            modifiedWorkflow[inputNodeId].inputs[inputNameInNode] = defaultValueElement.value;

            inputOptionsList.push(inputOptions);
        }

        modifiedWorkflow['_comfyuimini_meta'] = {} as WorkflowMetadata;
        modifiedWorkflow['_comfyuimini_meta']['title'] = this.titleInput.value || 'Unnamed Workflow';
        modifiedWorkflow['_comfyuimini_meta']['description'] = this.descriptionInput.value || '';
        modifiedWorkflow['_comfyuimini_meta']['format_version'] = '2';

        modifiedWorkflow['_comfyuimini_meta']['input_options'] = inputOptionsList;

        return modifiedWorkflow as WorkflowWithMetadata;
    }
}

// -------
// Editing
// -------

/**
 * Move an input up.
 *
 * @param {HTMLElement} item The input container.
 */
function moveUp(item: HTMLElement) {
    if (!item.parentNode) {
        return;
    }

    const previousItem = item.previousElementSibling;

    if (previousItem) {
        item.parentNode.insertBefore(item, previousItem);
    }
}

/**
 * Move an input down.
 *
 * @param {HTMLElement} item The input container.
 */
function moveDown(item: HTMLElement) {
    if (!item.parentNode) {
        return;
    }

    const nextItem = item.nextElementSibling;

    if (nextItem) {
        item.parentNode.insertBefore(nextItem, item);
    }
}
