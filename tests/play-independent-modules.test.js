import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPlayModuleSource } from '../play-task-module.js';
import { createPlayLocalEvents } from '../play-template-context.js';

test('任务模块绑定目标资料，保留原生别名/命名空间和变量实时导出；不修改原模块', () => {
    const source = `import { chat as messages, name2 } from './host.js';
        import * as native from './native.js';
        export let count = 0;
        export function value() { count++; return [messages.length, name2, native.version]; }`;
    const compiled = bindPlayModuleSource(source, 'https://test.invalid/scripts/task.js', ['chat', 'name2']);
    const run = new Function('__teaArguments', compiled);
    const imports = { 'https://test.invalid/scripts/native.js': { version: 2 } };
    const a = run({ chat: [1], name2: '甲', originalImports: imports, console });
    const b = run({ chat: [], name2: '乙', originalImports: imports, console });
    assert.deepEqual(a.value(), [1, '甲', 2]); assert.equal(a.count, 1); assert.equal(b.count, 0);
    assert.deepEqual(b.value(), [0, '乙', 2]); assert.ok(source.includes('import { chat'));
    assert.throws(() => bindPlayModuleSource('export * from "./foo.js";', 'https://test.invalid/a.js', []), error => error.code === 'independent_module_exports');
});

test('原生单例的别名导出指向各自任务的实例', () => {
    const source = `export const version = 1; let instance;
        export { instance as Engine };
        class Engine { run() { return version; } }
        instance = new Engine();`;
    const run = new Function('__teaArguments', bindPlayModuleSource(source, 'https://test.invalid/engine.js', []));
    const a = run({ console }), b = run({ console });
    assert.equal(a.Engine.run(), 1); assert.notEqual(a.Engine, b.Engine);
});

test('任务事件有顺序且可撤销，不广播到主聊天', async () => {
    const a = createPlayLocalEvents(), b = createPlayLocalEvents(), result = [];
    const removed = () => result.push('removed');
    a.on('e', () => result.push(2)); a.makeFirst('e', () => result.push(1)); a.makeLast('e', () => result.push(3));
    a.on('e', removed); a.removeListener('e', removed); b.on('e', () => result.push('other'));
    await a.emit('e'); assert.deepEqual(result, [1, 2, 3]);
});
