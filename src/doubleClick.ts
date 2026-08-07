/** Max delay (ms) between two clicks on the same tree item to count as a double click. */
export const DOUBLE_CLICK_MS = 500;

/**
 * VS Code fires a tree item's command on every single click, so a view that
 * should only open on a double click has to recognise the second click itself.
 */
export class DoubleClickGate {
    private last: { key: string; time: number } = { key: '', time: 0 };

    constructor(private readonly windowMs: number = DOUBLE_CLICK_MS) {}

    /** True when this click completes a double click on the same key. */
    accept(key: string, now: number = Date.now()): boolean {
        if (this.last.key === key && now - this.last.time < this.windowMs) {
            this.last = { key: '', time: 0 };
            return true;
        }
        this.last = { key, time: now };
        return false;
    }
}
