import fs from 'fs';
import Parser, { Options } from 'luaparse';
import { argv } from 'node:process';
import { Chunk, minify } from './ast2lua';

const luaparseSetting: Partial<Options> = {
    locations: true,
    luaVersion: '5.3',
    ranges: true,
    scope: true,
}

const argPath = argv[2];

if (fs.existsSync(argPath)) {
    const code = fs.readFileSync(argPath).toString();
    const ast = Parser.parse(code, luaparseSetting) as Chunk;
    if ("globals" in ast) {
        const map = minify(ast);
    
        map.add("\n--[[\n//# sourceMappingURL=test.lua.map\n]]");
        console.log(map.toStringWithSourceMap().code);
        // toStringWithSourceMap().map の file に書き出したのちのファイル名を入れないとVSCode Extでは検索失敗する
        //console.log(JSON.stringify(map.toStringWithSourceMap().map));
    }
}
