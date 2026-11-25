/**
 * Text in every form the date picker (`parseDateTimeInput` in
 * src/webview/dateTimePicker.js) accepts, for the tests that check its
 * consumers accept the same: the View Data variables form on the host and the
 * Data Viewer's date filter.
 */
export const PICKER_INPUTS: readonly string[] = [
    '2026-11-25', '2026-1-5', '25.11.2026', '5.1.2026',
    '2026-11-25 10:39', '2026-11-25T10:39', '2026-11-25t10:39', '2026-11-25T 10:39', '2026-11-25   9:05',
    '2026-11-25 10:39:15', '2026-11-25 10:39:15.123456', '25.11.2026 10:39', '25.11.2026T10:39:15.5',
    '2026-11-25 10:39+01', '2026-11-25 10:39:15-05:30', '2026-11-25 10:39 +0530', '2026-11-25T10:39Z', '2026-11-25 10:39z',
    'infinity', '-infinity', '+Infinity'
];

/** Shortcuts the picker resolves against the browser's clock before a value is used. */
export const PICKER_SHORTCUTS: readonly string[] = ['now', 'today', '10:39', '10:39:15+01'];
