import { PlaygroundError } from './playground.js';
import { loadPlayModuleSource, quietPlayConsole } from './play-task-module.js';

/** Use the native insertion rule, supplying note text instead of its UI input. */
export async function createPlayNoteContext(modules, environment, core) {
    const source = await loadPlayModuleSource('/scripts/authors-note.js');
    const rule = source.match(/export function setFloatingPrompt\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    if (!rule) throw new PlaygroundError('note_version_not_supported', '当前酒馆的作者注释接口尚未支持独立角色处理，本次没有发送。');
    const keys = modules.notes.metadata_keys, note = environment.tavern.extensionSettings?.note ?? {};
    for (const [key, value] of Object.entries({ prompt: note.default ?? '', interval: note.defaultInterval ?? 1,
        position: note.defaultPosition ?? 1, depth: note.defaultDepth ?? 4, role: note.defaultRole ?? 0 })) {
        core.chat_metadata[keys[key]] ??= value;
    }
    const bindings = { console: quietPlayConsole, MODULE_NAME: modules.notes.NOTE_MODULE_NAME, metadata_keys: keys,
        chat_metadata: core.chat_metadata, extension_settings: { note }, extension_prompt_types: core.extension_prompt_types,
        MAX_INJECTION_DEPTH: modules.core.MAX_INJECTION_DEPTH, chara_note_position: { replace: 0, before: 1, after: 2 },
        getCharaFilename: () => environment.character.avatar.replace(/\.[^/.]+$/, ''),
        getContext: () => ({ characterId: 0, chat: core.chat, setExtensionPrompt: core.setExtensionPrompt }),
        $: selector => selector === '#extension_floating_prompt' ? { val: () => core.chat_metadata[keys.prompt] } : { text() {} },
    };
    const declarations = Object.keys(bindings).map(key => `const ${key} = bindings[${JSON.stringify(key)}];`).join('\n');
    return new Function('bindings', declarations + '\nlet shouldWIAddPrompt = false;\n' + rule.replace('export ', '')
        + '\nreturn { setFloatingPrompt, metadata_keys, NOTE_MODULE_NAME: MODULE_NAME, get shouldWIAddPrompt() { return shouldWIAddPrompt; } };')(bindings);
}
