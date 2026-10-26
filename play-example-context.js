import { PlaygroundError } from './playground.js';
import { loadPlayModuleSource } from './play-task-module.js';

/** Keep each host version's example parser, with this task's participants. */
export function bindPlayExampleFormatter(source, userName, characterName) {
    const formatter = source.match(/function setOpenAIMessageExamples\(mesExamplesArray\)\s*\{[\s\S]*?\n\}/)?.[0];
    const parser = source.match(/export function parseExampleIntoIndividual\(messageExampleString, appendNamesForGroup = true\)\s*\{[\s\S]*?\n\}/)?.[0];
    if (!formatter || !parser) throw new PlaygroundError('example_version_not_supported', '当前酒馆的示例对话接口尚未支持独立角色处理，本次没有发送。');
    return new Function('name1', 'name2', 'selected_group', 'getGroupNames',
        formatter + '\n' + parser.replace('export ', '') + '\nreturn setOpenAIMessageExamples;')
        (userName, characterName, null, () => []);
}

export async function createPlayExampleFormatter(environment) {
    return bindPlayExampleFormatter(await loadPlayModuleSource('/scripts/openai.js'), environment.tavern.name1, environment.character.name);
}
