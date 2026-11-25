import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewDataFromSelect } from '../viewDataFromSelect';
import { VARIABLE_KINDS, formatVariableValue } from '../sqlVariableValues';

type PromptVariable = { name: string; value: string; kind: string; listKind?: string };

function modalHtml(variables: PromptVariable[], sql = 'SELECT * FROM t WHERE id = :id'): string {
    const view = new ViewDataFromSelect({} as any, {} as any, {} as any);
    return (view as any).getModalHtml({ cspSource: 'vscode-resource:' }, sql, variables);
}

/** Just enough of a DOM element for the form's script. */
class FakeElement {
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    dataset: Record<string, string> = {};
    listeners: Record<string, (event: any) => void> = {};
    classes = new Set<string>();
    hidden = false;
    disabled = false;
    value = '';
    type = '';
    textContent = '';
    [key: string]: any;
    constructor(public tagName: string) {}
    get classList() {
        return {
            toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); },
            add: (...names: string[]) => names.forEach(n => this.classes.add(n)),
            remove: (...names: string[]) => names.forEach(n => this.classes.delete(n)),
            contains: (name: string) => this.classes.has(name)
        };
    }
    attributes: Record<string, string> = {};
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    removeAttribute(name: string): void { delete this.attributes[name]; }
    insertAdjacentElement(_where: 'afterend', el: FakeElement): void {
        const siblings = this.parent!.children;
        siblings.splice(siblings.indexOf(this) + 1, 0, el);
        el.parent = this.parent;
    }
    remove(): void {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }
    removeEventListener(type: string): void { delete this.listeners[type]; }
    appendChild(child: FakeElement): void { child.parent = this; this.children.push(child); }
    replaceChildren(...children: FakeElement[]): void {
        this.children = [];
        children.forEach(c => this.appendChild(c));
    }
    querySelector(selector: string): FakeElement | null {
        const role = /^\[data-role="(\w+)"\]$/.exec(selector)?.[1];
        for (const child of this.children) {
            if (child.dataset.role === role) return child;
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
    closest(selector: string): FakeElement | null {
        for (let el: FakeElement | null = this; el; el = el.parent) {
            if (selector === '.var-row' && el.classes.has('var-row')) return el;
        }
        return null;
    }
    addEventListener(type: string, listener: (event: any) => void): void { this.listeners[type] = listener; }
    dispatchEvent(event: { type: string }): boolean {
        for (let el: FakeElement | null = this; el; el = el.parent) el.listeners[event.type]?.({ type: event.type, target: this });
        return true;
    }
    focus(): void { focused = this; }
    select(): void { /* nothing to select */ }
}

let focused: FakeElement | null = null;

function runFormScript(variables: PromptVariable[]) {
    const html = modalHtml(variables);
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    const form = new FakeElement('FORM');
    const rows = variables.map((_v, i) => {
        const row = new FakeElement('DIV');
        row.classes.add('var-row');
        row.dataset.index = String(i);
        for (const role of ['kind', 'input', 'listKind', 'error']) {
            const el = new FakeElement(role === 'kind' || role === 'listKind' ? 'SELECT' : 'DIV');
            el.dataset.role = role;
            row.appendChild(el);
        }
        form.appendChild(row);
        return row;
    });
    form.querySelectorAll = () => rows;
    const elements: Record<string, FakeElement> = { form, runBtn: new FakeElement('BUTTON'), preview: new FakeElement('PRE'), cancelBtn: new FakeElement('BUTTON') };
    const docListeners: Record<string, (event: any) => void> = {};
    const document = {
        getElementById: (id: string) => elements[id],
        createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
        addEventListener: (type: string, fn: (event: any) => void) => { docListeners[type] = fn; }
    };
    let receive: (event: { data: any }) => void = () => undefined;
    const window = { addEventListener: (_type: string, fn: (event: { data: any }) => void) => { receive = fn; } };
    const sent: any[] = [];
    focused = null;
    new Function('acquireVsCodeApi', 'document', 'window', script)(
        () => ({ postMessage: (m: any) => sent.push(m) }), document, window
    );
    const valueOf = (i: number) => rows[i].querySelector('[data-role="input"]')!.children[0];
    const edit = (target: FakeElement, value: string) => { target.value = value; form.listeners.input({ target }); };
    // The element's own keydown listener (the date picker's) runs before the document's.
    const key = (k: string, target: FakeElement, ctrlKey = false) => {
        const event = { key: k, ctrlKey, target, preventDefault: () => undefined, stopPropagation: () => undefined };
        target.listeners.keydown?.(event);
        docListeners.keydown(event);
    };
    return { rows, sent, elements, valueOf, edit, key, send: (data: any) => receive({ data }) };
}

// ===== the variables form =====

test('every variable offers every type, with its starting type selected', () => {
    const html = modalHtml([
        { name: ':id', value: '', kind: 'number' },
        { name: ':ids', value: '', kind: 'list', listKind: 'number' }
    ]);
    for (const { label } of VARIABLE_KINDS) {
        assert.equal(html.split(`>${label}</option>`).length - 1 >= 2, true, `${label} is not offered for each variable`);
    }
    assert.match(html, /<option value="number" selected>Number<\/option>/);
    assert.match(html, /<option value="list" selected>List<\/option>/);
    assert.doesNotMatch(html, /\son[a-z]+="/, 'inline handlers are blocked by the CSP');
});

test('a variable name cannot close the script it is embedded in', () => {
    const html = modalHtml([{ name: '</script><b>', value: '', kind: 'sql' }]);
    assert.equal(html.split('</script>').length - 1, 1);
});

test('the form focuses the first field, renders the control for each type and asks for a preview', () => {
    const form = runFormScript([
        { name: ':id', value: '7', kind: 'number' },
        { name: ':ids', value: 'a', kind: 'list', listKind: 'string' }
    ]);
    assert.equal(focused, form.valueOf(0));
    assert.equal(form.valueOf(1).tagName, 'TEXTAREA');
    assert.equal(form.rows[0].querySelector('[data-role="listKind"]')!.hidden, true);
    assert.equal(form.rows[1].querySelector('[data-role="listKind"]')!.hidden, false);
    assert.deepEqual(form.sent[0], {
        command: 'preview', seq: 1, inputs: {
            ':id': { value: '7', kind: 'number', listKind: 'string' },
            ':ids': { value: 'a', kind: 'list', listKind: 'string' }
        }
    });
});

test('a boolean without a remembered value starts as true instead of an invalid empty value', () => {
    const form = runFormScript([{ name: ':b', value: '', kind: 'boolean' }]);
    assert.equal(form.valueOf(0).tagName, 'SELECT');
    assert.equal(form.sent[0].inputs[':b'].value, 'true');
});

test('changing the type swaps the control and keeps the value where it fits', () => {
    const form = runFormScript([{ name: ':d', value: '2024-01-31 13:45:00', kind: 'timestamp' }]);
    assert.equal(form.valueOf(0).type, 'text', 'no AM/PM browser field: a typed 24-hour value plus the picker');
    assert.equal(form.valueOf(0).value, '2024-01-31 13:45:00');
    assert.equal(form.valueOf(0).placeholder, 'YYYY-MM-DD HH:MM');
    const pickerButton = form.rows[0].querySelector('[data-role="input"]')!.children[1];
    assert.equal(pickerButton.title, 'Pick a date and time (Alt+Down)');

    form.edit(form.rows[0].querySelector('[data-role="kind"]')!, 'date');
    assert.equal(form.valueOf(0).type, 'text');
    assert.equal(form.valueOf(0).value, '2024-01-31');
    assert.equal(form.valueOf(0).placeholder, 'YYYY-MM-DD');
    assert.equal(form.rows[0].querySelector('[data-role="input"]')!.children.length, 2, 'one picker button, the old one is gone');

    form.edit(form.rows[0].querySelector('[data-role="kind"]')!, 'boolean');
    assert.equal(form.valueOf(0).tagName, 'SELECT');
    assert.equal(form.rows[0].querySelector('[data-role="input"]')!.children.length, 1);

    form.edit(form.rows[0].querySelector('[data-role="kind"]')!, 'timestamp');
    assert.equal(form.valueOf(0).value, '2024-01-31 13:45:00', 'the earlier timestamp comes back');
    assert.deepEqual(form.sent[form.sent.length - 1].inputs[':d'], { value: '2024-01-31 13:45:00', kind: 'timestamp', listKind: 'string' });
});

test('a value typed day first becomes ISO text when it is carried over to a date', () => {
    const form = runFormScript([{ name: ':d', value: '25.11.2026 10:39', kind: 'string' }]);
    form.edit(form.rows[0].querySelector('[data-role="kind"]')!, 'timestamp');
    assert.equal(form.valueOf(0).value, '2026-11-25 10:39');
    form.edit(form.rows[0].querySelector('[data-role="kind"]')!, 'date');
    assert.equal(form.valueOf(0).value, '2026-11-25');
});

test('an error from the host disables Run until a later preview is clean; Enter asks the host, Esc cancels', () => {
    const form = runFormScript([{ name: ':n', value: '', kind: 'number' }]);
    form.edit(form.valueOf(0), 'abc');
    const seq = form.sent[form.sent.length - 1].seq;

    form.send({ command: 'preview', seq: seq - 1, sql: 'stale', errors: {} });
    assert.notEqual(form.elements.preview.textContent, 'stale', 'an outdated reply is ignored');

    form.send({ command: 'preview', seq, sql: 'SELECT :n', errors: { ':n': '"abc" is not a number.' } });
    assert.equal(form.elements.runBtn.disabled, true);
    assert.equal(form.rows[0].querySelector('[data-role="error"]')!.textContent, '"abc" is not a number.');
    form.key('Enter', form.valueOf(0));
    assert.deepEqual(form.sent[form.sent.length - 1], {
        command: 'submit', seq: seq + 1, inputs: { ':n': { value: 'abc', kind: 'number', listKind: 'string' } }
    }, 'the host checks the values and posts the errors back instead of running');
    form.send({ command: 'preview', seq: seq + 1, sql: 'SELECT :n', errors: { ':n': '"abc" is not a number.' } });
    assert.equal(form.elements.runBtn.disabled, true);

    form.edit(form.valueOf(0), '12');
    form.send({ command: 'preview', seq: seq + 2, sql: 'SELECT 12', errors: {} });
    assert.equal(form.elements.runBtn.disabled, false);
    assert.equal(form.elements.preview.textContent, 'SELECT 12');
    form.key('Enter', form.valueOf(0));
    assert.deepEqual(form.sent[form.sent.length - 1], {
        command: 'submit', seq: seq + 3, inputs: { ':n': { value: '12', kind: 'number', listKind: 'string' } }
    });

    form.key('Escape', form.valueOf(0));
    assert.deepEqual(form.sent[form.sent.length - 1], { command: 'cancel' });
});

test('Enter right after typing now runs with the timestamp the picker wrote, though Run was disabled', () => {
    const form = runFormScript([{ name: ':t', value: '', kind: 'timestamp' }]);
    form.edit(form.valueOf(0), 'now');
    const seq = form.sent[form.sent.length - 1].seq;
    form.send({ command: 'preview', seq, sql: 'SELECT :t', errors: { ':t': 'Enter a timestamp.' } });
    assert.equal(form.elements.runBtn.disabled, true);

    form.key('Enter', form.valueOf(0));
    const last = form.sent[form.sent.length - 1];
    assert.equal(last.command, 'submit');
    assert.match(last.inputs[':t'].value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(form.valueOf(0).value, last.inputs[':t'].value);
    assert.equal(formatVariableValue(last.inputs[':t'].value, 'timestamp').error, undefined, 'the host accepts it and runs');
});

// ===== askForVariableValues =====

function viewWithCatalog(columns: Array<{ tbl: string; col: string; type: string }>) {
    const state: Record<string, unknown> = {};
    const context = { globalState: { get: (key: string, fallback: unknown) => state[key] ?? fallback, update: async (key: string, value: unknown) => { state[key] = value; } } };
    const view = new ViewDataFromSelect(context as any, { queryMetadata: async () => columns } as any, {} as any);
    const prompts: Array<{ sql: string; names: string[]; label: string }> = [];
    let answer: Record<string, unknown> | undefined;
    (view as any).promptForVariables = async (sql: string, variables: PromptVariable[], _sep: string, label: string) => {
        prompts.push({ sql, names: variables.map(v => v.name), label });
        return answer;
    };
    return { view, prompts, state, answer: (value: Record<string, unknown> | undefined) => { answer = value; } };
}

test('askForVariableValues returns the SQL unchanged without asking when it has no variables', async () => {
    const { view, prompts } = viewWithCatalog([{ tbl: 't', col: 'a', type: 'integer' }]);
    assert.equal(await view.askForVariableValues('SELECT * FROM t WHERE b = 1'), 'SELECT * FROM t WHERE b = 1');
    assert.equal(await view.askForVariableValues('SELECT * FROM t WHERE b = a'), 'SELECT * FROM t WHERE b = a', 'a column is no variable');
    assert.equal(prompts.length, 0);
});

test('askForVariableValues fills in the entered values, remembers them and returns undefined on cancel', async () => {
    const { view, prompts, state, answer } = viewWithCatalog([{ tbl: 't', col: 'id', type: 'integer' }]);
    answer({ ':id': { value: '42', kind: 'number' } });
    assert.equal(await view.askForVariableValues('SELECT * FROM t WHERE id = :id', { actionLabel: 'Run' }), 'SELECT * FROM t WHERE id = 42');
    assert.deepEqual(prompts.map(p => [p.names, p.label]), [[[':id'], 'Run']]);
    assert.ok(state.viewDataVariableCache);
    answer(undefined);
    assert.equal(await view.askForVariableValues('SELECT * FROM t WHERE id = :id'), undefined);
    assert.equal(prompts[1].label, 'View Data');
});

test('the variables form names its run button after the action', () => {
    const view = new ViewDataFromSelect({} as any, {} as any, {} as any);
    const html: string = (view as any).getModalHtml({ cspSource: 'vscode-resource:' }, 'SELECT :id', [{ name: ':id', value: '', kind: 'sql' }], 'Run');
    assert.match(html, /id="runBtn">[\s\S]*?Run<\/button>/);
});
