import { readFile, readdir, lstat} from 'fs/promises';
import assert from 'node:assert/strict';


async function *discoverRefpagesInDir(dir: string): AsyncGenerator<string> {
    for (const fileName of await readdir(dir)) {
        const filePath = dir + '/' + fileName;
        if ((await lstat(filePath)).isDirectory()) {
            for await (const i of discoverRefpagesInDir(filePath)) {
                yield i;
            }
        }
        if (!fileName.endsWith('.adoc')) {
            continue;
        }
        yield filePath;
    }
}

export type Refpage = {
    desc: string,
    name: string,
    type: string,
    alias?: string,
    anchor?: string,
    xrefs: string[],
    content?: string,
}


function parseRefpageLine(line: string, _filepath: string): Refpage | null {
    const pattern = /^\[open *,(.+)\]$/;
    const result = pattern.exec(line);
    if (!result) {
        return null;
    }
    let content = '{' + result[1] + '}';
    
    content = content
    .replaceAll('=', ':')
    .replaceAll(':\'', ':`')
    .replaceAll('\',', '`,')
    .replaceAll('\'}', '`}');
    const obj = eval('(' + content + ')');
    assert(obj.desc);
    assert(obj.refpage);
    assert(obj.type);
    return {
        name: obj.refpage,
        type: obj.type,
        desc: obj.desc,
        alias: obj.alias,
        anchor: obj.anchor,
        xrefs: obj.xrefs ? obj.xrefs.split(' ') : [],
    }
}

async function *extractFromDocFile(docFilePath: string): AsyncGenerator<Refpage> {
    const content = await readFile(docFilePath, 'utf-8');

    let currentPage: null | Refpage = null;
    for (const line of content.split('\n')) {
        if (currentPage) {
            if (line === '--') {
                if (currentPage.content === undefined) {
                    // starting
                    currentPage.content = ''
                } else {
                    // ending
                    yield currentPage;
                    currentPage = null;
                }
                continue;
            }
            if (currentPage.content !== undefined) {
                currentPage.content += line + '\n';
            }
        } else {
            currentPage = parseRefpageLine(line, docFilePath);
        }
    }
    if (currentPage && currentPage.name !== 'provisional-headers') {
        yield currentPage;
    }
}
export default async function* discoverRefpages(): AsyncGenerator<Refpage> {
    

    for await (const path of discoverRefpagesInDir('./Vulkan-Docs/chapters')) {
        for await (const i of extractFromDocFile(path)) {
            yield i;
        }
    }
    for await (const path of discoverRefpagesInDir('./Vulkan-Docs/appendices')) {
        for await (const i of extractFromDocFile(path)) {
            yield i;
        }
    }
}