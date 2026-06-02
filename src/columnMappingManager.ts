import * as vscode from 'vscode';

export interface MappingCondition {
    column: string;
    operator: string;
    value: string;
}

export interface CustomColumnMapping {
    id: string;
    sourceSchema: string;
    sourceTable: string;
    sourceColumn: string;
    targetSchema: string;
    targetTable: string;
    targetColumn: string;
    conditions: MappingCondition[];
    isDefault: boolean;
    label?: string;
    /** True when this mapping is a synthesized reverse view of a user-defined mapping. */
    reversed?: boolean;
    /** When reversed, the id of the original (forward) mapping for reference. */
    originalId?: string;
}

export class ColumnMappingManager {
    private static readonly STORAGE_KEY = 'customColumnMappings';
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    getAllMappings(): CustomColumnMapping[] {
        return this.context.globalState.get<CustomColumnMapping[]>(ColumnMappingManager.STORAGE_KEY, []);
    }

    getMappingsForTable(schema: string, table: string): CustomColumnMapping[] {
        const all = this.getAllMappings();
        const forward = all.filter(m => m.sourceSchema === schema && m.sourceTable === table);
        const reverse = all
            .filter(m => m.targetSchema === schema && m.targetTable === table
                && !(m.sourceSchema === schema && m.sourceTable === table))
            .map(m => this.reverseMapping(m));
        return [...forward, ...reverse];
    }

    getMappingsForColumn(schema: string, table: string, column: string): CustomColumnMapping[] {
        const all = this.getAllMappings();
        const forward = all.filter(m => m.sourceSchema === schema && m.sourceTable === table && m.sourceColumn === column);
        const reverse = all
            .filter(m => m.targetSchema === schema && m.targetTable === table && m.targetColumn === column
                && !(m.sourceSchema === schema && m.sourceTable === table && m.sourceColumn === column))
            .map(m => this.reverseMapping(m));
        return [...forward, ...reverse];
    }

    private reverseMapping(m: CustomColumnMapping): CustomColumnMapping {
        return {
            id: `rev:${m.id}`,
            sourceSchema: m.targetSchema,
            sourceTable: m.targetTable,
            sourceColumn: m.targetColumn,
            targetSchema: m.sourceSchema,
            targetTable: m.sourceTable,
            targetColumn: m.sourceColumn,
            // Conditions reference columns of the original source row and cannot be
            // evaluated against the reverse-side row, so they are dropped.
            conditions: [],
            // Reverse mappings never act as default FK button to avoid surprises;
            // users can create an explicit forward mapping if they want that.
            isDefault: false,
            label: m.label,
            reversed: true,
            originalId: m.id
        };
    }

    addMapping(mapping: Omit<CustomColumnMapping, 'id'>): CustomColumnMapping {
        const all = this.getAllMappings();
        const newMapping: CustomColumnMapping = {
            ...mapping,
            id: this.generateId()
        };
        all.push(newMapping);
        this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, all);
        return newMapping;
    }

    updateMapping(id: string, updates: Partial<Omit<CustomColumnMapping, 'id'>>): void {
        const all = this.getAllMappings();
        const idx = all.findIndex(m => m.id === id);
        if (idx >= 0) {
            all[idx] = { ...all[idx], ...updates };
            this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, all);
        }
    }

    deleteMapping(id: string): void {
        let all = this.getAllMappings();
        all = all.filter(m => m.id !== id);
        this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, all);
    }

    /**
     * Get applicable mappings for a specific cell, considering conditions.
     * rowData is the full row to evaluate conditions against.
     */
    getApplicableMappings(schema: string, table: string, column: string, rowData: Record<string, any>): CustomColumnMapping[] {
        const mappings = this.getMappingsForColumn(schema, table, column);
        return mappings.filter(m => this.evaluateConditions(m.conditions, rowData));
    }

    private evaluateConditions(conditions: MappingCondition[], rowData: Record<string, any>): boolean {
        if (!conditions || conditions.length === 0) return true;
        return conditions.every(cond => {
            const cellValue = rowData[cond.column];
            if (cellValue === null || cellValue === undefined) return false;
            const strVal = String(cellValue);
            switch (cond.operator) {
                case '=': return strVal === cond.value;
                case '!=': return strVal !== cond.value;
                case '>': return strVal > cond.value;
                case '<': return strVal < cond.value;
                case '>=': return strVal >= cond.value;
                case '<=': return strVal <= cond.value;
                case 'LIKE': return strVal.includes(cond.value);
                case 'ILIKE': return strVal.toLowerCase().includes(cond.value.toLowerCase());
                default: return strVal === cond.value;
            }
        });
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
    }
}
