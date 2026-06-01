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
        return all.filter(m => m.sourceSchema === schema && m.sourceTable === table);
    }

    getMappingsForColumn(schema: string, table: string, column: string): CustomColumnMapping[] {
        const all = this.getAllMappings();
        return all.filter(m => m.sourceSchema === schema && m.sourceTable === table && m.sourceColumn === column);
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
