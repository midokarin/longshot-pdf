import ts from 'typescript';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const parse = path => ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const messages = new Map();
function walk(node, fn) { fn(node); ts.forEachChild(node, child => walk(child, fn)); }
walk(parse('src/locales/en.ts'), node => {
 if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer)) {
  assert(!messages.has(node.name.text), `Duplicate key: ${node.name.text}`);
  messages.set(node.name.text, node.initializer.text);
 }
});
const placeholders = text => [...new Set([...text.matchAll(/\{(\d+)\}/g)].map(x => Number(x[1])))].sort();
for (const [key, value] of messages) {
 assert(value.trim(), `Empty translation: ${key}`);
 assert(!/[\u3400-\u9fff]/.test(value), `Chinese left in English translation: ${key}`);
 assert.deepEqual(placeholders(key), placeholders(value), `Interpolation mismatch: ${key}`);
 assert.deepEqual(key.match(/\{\{\w+\}\}/g) ?? [], value.match(/\{\{\w+\}\}/g) ?? [], `Export variable mismatch: ${key}`);
}
let calls = 0;
for (const file of fs.readdirSync('src').filter(x => x.endsWith('.ts'))) {
 walk(parse('src/' + file), node => {
  if (ts.isCallExpression(node) && node.expression.getText() === 't') {
   const key = node.arguments[0];
   assert(key && ts.isStringLiteral(key) && messages.has(key.text), `${file}: Unknown translation key`);
   const slots = placeholders(key.text);
   assert.equal(node.arguments.length - 1, slots.length ? Math.max(...slots) + 1 : 0, `${file}: Wrong argument count for ${key.text}`);
   calls++;
  }
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /[\u3400-\u9fff]/.test(node.text)) {
   assert(ts.isCallExpression(node.parent) && node.parent.expression.getText() === 't' && node.parent.arguments[0] === node, `${file}: Untranslated text: ${node.text}`);
  }
 });
}
console.log(`Localization checks passed: ${messages.size} translations, ${calls} call sites.`);
