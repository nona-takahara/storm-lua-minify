import fs from 'fs';
import Parser, { Options } from 'luaparse';
import { argv } from 'node:process';
import { ast2lua } from './ast2lua';

const luaparseSetting: Partial<Options> = {
    locations: true,
    luaVersion: '5.3',
    ranges: true,
    scope: true
}

const argPath = argv[2];
console.log(argPath);

if (fs.existsSync(argPath)) {
    const ast = Parser.parse(fs.readFileSync(argPath).toString(), luaparseSetting);
    ast2lua(ast);
}
