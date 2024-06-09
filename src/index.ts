import fs from 'fs';
import Parser, { Options } from 'luaparse';
import { argv } from 'node:process';
import { minify } from './ast2lua';

const luaparseSetting: Partial<Options> = {
    locations: true,
    luaVersion: '5.3',
    ranges: true,
    scope: true
}

const argPath = argv[2];
console.log("--", argPath, fs.existsSync(argPath));

if (fs.existsSync(argPath)) {
    const ast = Parser.parse(fs.readFileSync(argPath).toString(), luaparseSetting);
    console.log(minify(ast));
}
