import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = require.resolve('jspdf/dist/jspdf.es.js');
const expectedHash = '5b7f65fa3928b104febbcc37c7174f8e5aa3b8d9d24d0378a3fecad693d86f76';

// jsPDF 4.2.1 includes an optional PDFObject viewer that downloads a script.
// Longshot uses output("arraybuffer") only. Remove the entire unused viewer
// implementation, not just the scanner-visible script creation statement.
// Pin the input hash so an upstream change requires an explicit review.
export function localPdfPlugin() {
 return {
  name: 'jspdf-local-output',
  setup(build) {
   build.onResolve({filter: /^jspdf$/}, () => ({path: sourcePath}));
   build.onLoad({filter: /jspdf\.es\.js$/}, async ({path}) => {
    const source = await readFile(path, 'utf8');
    if (createHash('sha256').update(source).digest('hex') !== expectedHash) {
     throw new Error('jsPDF source changed. Review the local-output build adaptation before updating its hash.');
    }
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const matches = [];
    function visit(node) {
     if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'pdfobjectnewwindow') matches.push(node);
     ts.forEachChild(node, visit);
    }
    visit(ast);
    if (matches.length !== 1) throw new Error('Expected exactly one PDFObject viewer branch.');
    const branch = matches[0];
    const contents = source.slice(0, branch.getStart(ast)) + source.slice(branch.end);
    return {contents, loader: 'js'};
   });
  },
 };
}
