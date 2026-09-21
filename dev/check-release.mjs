import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source = fs.readFileSync('main.js','utf8');
const ast = ts.createSourceFile('main.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function visit(node) {
 if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
  const method=node.expression.name.text;
  const arg=node.arguments[0];
  if(method==='createElement' && arg && ts.isStringLiteral(arg)) assert.notEqual(arg.text.toLowerCase(),'script','Runtime script creation in release bundle');
  assert(!['getFiles','getMarkdownFiles'].includes(method),'Vault-wide enumeration in release bundle');
 }
 ts.forEachChild(node,visit);
}
visit(ast);
assert(!source.includes('pdfobjectnewwindow'));
assert(!source.includes('pdfobject.min.js'));
const css=fs.readFileSync('styles.css','utf8');
assert(!/!important|scrollbar-width\s*:/.test(css),'Unsupported CSS or important override');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8'));
assert.equal(pkg.license,'MIT');assert.equal(pkg.version,manifest.version);
assert(!pkg.devDependencies['builtin-modules']);
assert(fs.readFileSync('LICENSE','utf8').startsWith('MIT License'));
assert(fs.readFileSync('README.md','utf8').includes('## Download and install'));
console.log('Release checks passed: no script injection, no vault-wide enumeration, CSS compatibility, MIT license, English README.');
