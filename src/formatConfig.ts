import { coerceFormatOptions, FormatOptions } from './plpgsqlFormatter';
import { readFormatConfigFile, resolveFormatConfigPath } from './repoFormatConfig';

type SettingGetter = (configKey: string) => unknown;

interface FormatSettingBinding {
    shortKey: string;
    configKey: string;
}

const FORMAT_SETTING_BINDINGS: readonly FormatSettingBinding[] = [
    { shortKey: 'keywordCase', configKey: 'format.keywordCase' },
    { shortKey: 'identifierCase', configKey: 'format.identifierCase' },
    { shortKey: 'dataTypeCase', configKey: 'format.dataTypeCase' },
    { shortKey: 'indentStyle', configKey: 'format.indentStyle' },
    { shortKey: 'indentSize', configKey: 'format.indentSize' },
    { shortKey: 'commaStyle', configKey: 'format.commaStyle' },
    { shortKey: 'blankLines', configKey: 'format.blankLines' },
    { shortKey: 'simpleSelectSingleLine', configKey: 'format.simpleSelectSingleLine' },
    { shortKey: 'preserveSingleLineRoutineHeaders', configKey: 'format.preserveSingleLineRoutineHeaders' },
    { shortKey: 'preserveSingleLineIfBlocks', configKey: 'format.preserveSingleLineIfBlocks' },
    { shortKey: 'preserveSingleLineSpecialCases', configKey: 'format.preserveSingleLineSpecialCases' },
    { shortKey: 'listThresholds', configKey: 'format.listThresholds' },
    { shortKey: 'normalizeDataTypes', configKey: 'format.normalizeDataTypes' },
    { shortKey: 'dataTypeAliases', configKey: 'format.dataTypeAliases' },
    { shortKey: 'argumentGroups', configKey: 'format.argumentGroups' }
];

export function resolveFormatOptions(settingGetter: SettingGetter, workspaceFolderPath?: string, configPath?: string): FormatOptions {
    const resolvedPath = resolveFormatConfigPath(workspaceFolderPath, configPath);
    const repo = resolvedPath ? readFormatConfigFile(resolvedPath) : {};
    const raw: Record<string, unknown> = {};

    for (const binding of FORMAT_SETTING_BINDINGS) {
        raw[binding.shortKey] = binding.shortKey in repo
            ? repo[binding.shortKey]
            : settingGetter(binding.configKey);
    }

    return coerceFormatOptions(raw);
}