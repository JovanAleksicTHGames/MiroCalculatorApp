class StickyNoteCalculator {
    constructor() {
        this.selectedItems = [];
        this.calculatorNotes = new Map(); // Track calculator notes and their dependencies
        this.init();
    }

    async init() {
        await miro.ready();

        // Set up event listeners
        document.getElementById('sumBtn').addEventListener('click', () => this.createCalculation('sum'));
        document.getElementById('productBtn').addEventListener('click', () => this.createCalculation('product'));

        // Listen for selection changes
        miro.board.ui.on('selection:update', (event) => {
            this.handleSelectionUpdate(event);
        });

        // Listen for item updates to recalculate
        miro.board.on('items:update', (event) => {
            this.handleItemsUpdate(event);
        });

        // Listen for item deletion to clean up
        miro.board.on('items:delete', (event) => {
            this.handleItemsDelete(event);
        });

        // Initial selection check
        this.updateSelection();

        // Restore calculator notes from metadata
        await this.restoreCalculatorNotes();
    }

    async updateSelection() {
        try {
            const selection = await miro.board.ui.getSelection();
            this.selectedItems = selection.filter(item =>
                item.type === 'sticky_note' && this.isNumeric(item.content)
            );
            this.updateUI();
        } catch (error) {
            console.error('Error updating selection:', error);
        }
    }

    handleSelectionUpdate(event) {
        this.updateSelection();
    }

    updateUI() {
        const selectionInfo = document.getElementById('selectionInfo');
        const sumBtn = document.getElementById('sumBtn');
        const productBtn = document.getElementById('productBtn');

        const numericCount = this.selectedItems.length;
        const hasEnough = numericCount >= 2;

        if (numericCount === 0) {
            selectionInfo.textContent = 'Select 2 or more sticky notes with numbers';
        } else if (numericCount === 1) {
            selectionInfo.textContent = `1 numeric sticky note selected. Select at least 1 more.`;
        } else {
            selectionInfo.textContent = `${numericCount} numeric sticky notes selected`;
        }

        sumBtn.disabled = !hasEnough;
        productBtn.disabled = !hasEnough;
    }

    isNumeric(value) {
        const cleanValue = value.toString().trim();
        return !isNaN(cleanValue) && !isNaN(parseFloat(cleanValue)) && cleanValue !== '';
    }

    getNumericValue(content) {
        const cleanValue = content.toString().trim();
        return parseFloat(cleanValue);
    }

    async createCalculation(operation) {
        try {
            if (this.selectedItems.length < 2) {
                this.showStatus('Please select at least 2 numeric sticky notes', 'error');
                return;
            }

            // Calculate the result
            const values = this.selectedItems.map(item => this.getNumericValue(item.content));
            const sourceIds = this.selectedItems.map(item => item.id);

            let result;
            let operationSymbol;

            if (operation === 'sum') {
                result = values.reduce((acc, val) => acc + val, 0);
                operationSymbol = '+';
            } else {
                result = values.reduce((acc, val) => acc * val, 1);
                operationSymbol = '×';
            }

            // Find a good position for the new sticky note
            const avgX = this.selectedItems.reduce((sum, item) => sum + item.x, 0) / this.selectedItems.length;
            const maxY = Math.max(...this.selectedItems.map(item => item.y));

            // Create the calculator sticky note
            const calculatorNote = await miro.board.createStickyNote({
                content: this.formatResult(result),
                x: avgX,
                y: maxY + 200, // Position below the selected items
                style: {
                    fillColor: operation === 'sum' ? '#d1c4e9' : '#c8e6c8', // Different colors for sum/product
                    textAlign: 'center'
                }
            });

            // Store the calculation metadata
            const calculationData = {
                type: 'calculator',
                operation: operation,
                sourceIds: sourceIds,
                operationSymbol: operationSymbol,
                createdAt: Date.now()
            };

            // Use tags to store metadata (Miro SDK v2 approach)
            await miro.board.updateItem({
                id: calculatorNote.id,
                tagIds: [`calc-${operation}-${Date.now()}`]
            });

            // Store in our local tracking
            this.calculatorNotes.set(calculatorNote.id, calculationData);

            // Store in board metadata for persistence
            await this.saveCalculatorNotesToMetadata();

            this.showStatus(`${operation === 'sum' ? 'Sum' : 'Product'} sticky note created successfully!`, 'success');

        } catch (error) {
            console.error('Error creating calculation:', error);
            this.showStatus('Error creating calculation. Please try again.', 'error');
        }
    }

    formatResult(value) {
        // Format the result nicely
        if (Number.isInteger(value)) {
            return value.toString();
        } else {
            // Round to reasonable decimal places
            return parseFloat(value.toFixed(6)).toString();
        }
    }

    async handleItemsUpdate(event) {
        // Check if any updated items are source notes for calculator notes
        for (const updatedItem of event.items) {
            if (updatedItem.type === 'sticky_note') {
                await this.recalculateIfNeeded(updatedItem.id);
            }
        }
    }

    async handleItemsDelete(event) {
        // Clean up deleted calculator notes from our tracking
        for (const deletedItem of event.items) {
            if (this.calculatorNotes.has(deletedItem.id)) {
                this.calculatorNotes.delete(deletedItem.id);
                await this.saveCalculatorNotesToMetadata();
            }
        }
    }

    async recalculateIfNeeded(updatedItemId) {
        // Find all calculator notes that depend on this updated item
        for (const [calculatorId, calcData] of this.calculatorNotes.entries()) {
            if (calcData.sourceIds.includes(updatedItemId)) {
                await this.updateCalculatorNote(calculatorId, calcData);
            }
        }
    }

    async updateCalculatorNote(calculatorId, calcData) {
        try {
            // Get current source items
            const sourceItems = [];
            for (const sourceId of calcData.sourceIds) {
                try {
                    const item = await miro.board.getItem(sourceId);
                    if (item && item.type === 'sticky_note' && this.isNumeric(item.content)) {
                        sourceItems.push(item);
                    }
                } catch (error) {
                    // Source item might be deleted, skip it
                    console.log('Source item not found:', sourceId);
                }
            }

            if (sourceItems.length === 0) {
                // All source items are gone, delete the calculator note
                try {
                    await miro.board.deleteItem(calculatorId);
                    this.calculatorNotes.delete(calculatorId);
                    await this.saveCalculatorNotesToMetadata();
                } catch (error) {
                    console.log('Calculator note already deleted:', calculatorId);
                }
                return;
            }

            // Recalculate the result
            const values = sourceItems.map(item => this.getNumericValue(item.content));
            let result;

            if (calcData.operation === 'sum') {
                result = values.reduce((acc, val) => acc + val, 0);
            } else {
                result = values.reduce((acc, val) => acc * val, 1);
            }

            // Update the calculator note
            await miro.board.updateItem({
                id: calculatorId,
                content: this.formatResult(result)
            });

        } catch (error) {
            console.error('Error updating calculator note:', error);
            // If the calculator note no longer exists, remove it from tracking
            if (error.message && error.message.includes('not found')) {
                this.calculatorNotes.delete(calculatorId);
                await this.saveCalculatorNotesToMetadata();
            }
        }
    }

    async saveCalculatorNotesToMetadata() {
        try {
            const data = Object.fromEntries(this.calculatorNotes);
            await miro.board.setMetadata('calculatorNotes', data);
        } catch (error) {
            console.error('Error saving calculator notes metadata:', error);
        }
    }

    async restoreCalculatorNotes() {
        try {
            const data = await miro.board.getMetadata('calculatorNotes');
            if (data) {
                this.calculatorNotes = new Map(Object.entries(data));

                // Clean up any calculator notes that no longer exist on the board
                const validCalculatorIds = [];
                for (const [calculatorId, calcData] of this.calculatorNotes.entries()) {
                    try {
                        await miro.board.getItem(calculatorId);
                        validCalculatorIds.push(calculatorId);
                    } catch (error) {
                        // Calculator note no longer exists
                        console.log('Removing deleted calculator note from tracking:', calculatorId);
                    }
                }

                // Update our tracking with only valid calculator notes
                const validEntries = Array.from(this.calculatorNotes.entries())
                    .filter(([id]) => validCalculatorIds.includes(id));
                this.calculatorNotes = new Map(validEntries);

                if (validEntries.length !== Object.keys(data).length) {
                    await this.saveCalculatorNotesToMetadata();
                }
            }
        } catch (error) {
            console.error('Error restoring calculator notes:', error);
        }
    }

    showStatus(message, type) {
        const statusElement = document.getElementById('statusMessage');
        statusElement.textContent = message;
        statusElement.className = `status ${type}`;
        statusElement.style.display = 'block';

        // Hide after 3 seconds
        setTimeout(() => {
            statusElement.style.display = 'none';
        }, 3000);
    }
}

// Initialize the app when the script loads
new StickyNoteCalculator();