import { createHash } from 'node:crypto';

const keywords = new Set([
  'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
  'assign', 'parameter', 'localparam', 'signed', 'unsigned'
]);
const multiCharacterOperators = ['<=', '>=', '==', '!=', '&&', '||', '<<', '>>'];

function diagnostic(code, message, token) {
  return {
    severity: 'ERROR',
    code,
    message,
    location: token ? { file: token.file, line: token.line, column: token.column } : null
  };
}

export function compileRtl({ files, projectVersionId, compilerVersion = '0.1.0', topModule = null }) {
  const diagnostics = [];
  const tokens = [];

  for (const file of [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (typeof file.content !== 'string') {
      diagnostics.push(diagnostic('RTL_FILE_CONTENT_INVALID', `File ${file.name} has no text content`));
      continue;
    }

    let index = 0;
    let line = 1;
    let column = 1;
    const advance = () => {
      const char = file.content[index++];
      if (char === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      return char;
    };

    while (index < file.content.length) {
      const char = file.content[index];
      if (/\s/.test(char)) {
        advance();
        continue;
      }
      if (char === '/' && file.content[index + 1] === '/') {
        while (index < file.content.length && advance() !== '\n') {}
        continue;
      }
      if (char === '/' && file.content[index + 1] === '*') {
        const start = { file: file.name, line, column };
        advance();
        advance();
        let closed = false;
        while (index < file.content.length) {
          if (file.content[index] === '*' && file.content[index + 1] === '/') {
            advance();
            advance();
            closed = true;
            break;
          }
          advance();
        }
        if (!closed) diagnostics.push(diagnostic('RTL_UNTERMINATED_COMMENT', 'Unterminated block comment', start));
        continue;
      }
      if (char === '`') {
        diagnostics.push(diagnostic('RTL_PREPROCESSOR_UNSUPPORTED', 'Preprocessor directives are not supported by this compiler subset', { file: file.name, line, column }));
        while (index < file.content.length && advance() !== '\n') {}
        continue;
      }

      const start = { file: file.name, line, column };
      if (/[A-Za-z_$]/.test(char)) {
        let text = advance();
        while (index < file.content.length && /[A-Za-z0-9_$]/.test(file.content[index])) text += advance();
        tokens.push({ kind: keywords.has(text) ? 'keyword' : 'identifier', text, ...start });
        continue;
      }
      if (/[0-9]/.test(char)) {
        let text = advance();
        while (index < file.content.length && /[A-Za-z0-9_'?]/.test(file.content[index])) text += advance();
        tokens.push({ kind: 'number', text, ...start });
        continue;
      }
      if (char === '"' || char === "'") {
        const quote = advance();
        let text = quote;
        let closed = false;
        while (index < file.content.length) {
          const next = advance();
          text += next;
          if (next === '\\' && index < file.content.length) {
            text += advance();
          } else if (next === quote) {
            closed = true;
            break;
          } else if (next === '\n') {
            break;
          }
        }
        if (!closed) diagnostics.push(diagnostic('RTL_UNTERMINATED_LITERAL', 'Unterminated string or based-number literal', start));
        tokens.push({ kind: 'literal', text, ...start });
        continue;
      }

      const operator = multiCharacterOperators.find((candidate) => file.content.startsWith(candidate, index));
      if (operator) {
        for (let count = 0; count < operator.length; count += 1) advance();
        tokens.push({ kind: 'operator', text: operator, ...start });
      } else if ('()[]{};,:.#=+-*/%!&|^~<>?'.includes(char)) {
        advance();
        tokens.push({ kind: 'punctuation', text: char, ...start });
      } else {
        advance();
        diagnostics.push(diagnostic('RTL_INVALID_CHARACTER', `Unexpected character ${JSON.stringify(char)}`, start));
      }
    }
  }

  const modules = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.text === 'endmodule') {
      diagnostics.push(diagnostic('RTL_UNEXPECTED_ENDMODULE', 'endmodule has no matching module declaration', token));
      cursor += 1;
      continue;
    }
    if (token.text !== 'module') {
      diagnostics.push(diagnostic('RTL_TOP_LEVEL_TOKEN_UNSUPPORTED', `Unexpected token ${token.text} outside a module`, token));
      cursor += 1;
      continue;
    }

    const start = token;
    const name = tokens[cursor + 1];
    if (!name || name.kind !== 'identifier') {
      diagnostics.push(diagnostic('RTL_MODULE_NAME_EXPECTED', 'Expected an identifier after module', start));
      cursor += 1;
      continue;
    }

    let headerEnd = cursor + 2;
    let parenDepth = 0;
    while (headerEnd < tokens.length) {
      if (tokens[headerEnd].text === '(') parenDepth += 1;
      if (tokens[headerEnd].text === ')') parenDepth -= 1;
      if (tokens[headerEnd].text === ';' && parenDepth === 0) break;
      if (tokens[headerEnd].text === 'endmodule') break;
      headerEnd += 1;
    }
    if (!tokens[headerEnd] || tokens[headerEnd].text !== ';') {
      diagnostics.push(diagnostic('RTL_MODULE_HEADER_INVALID', `Module ${name.text} has no terminating semicolon`, name));
      cursor = headerEnd;
      continue;
    }

    let end = headerEnd + 1;
    while (end < tokens.length && tokens[end].text !== 'endmodule' && tokens[end].text !== 'module') end += 1;
    if (!tokens[end] || tokens[end].text !== 'endmodule') {
      diagnostics.push(diagnostic('RTL_ENDMODULE_EXPECTED', `Module ${name.text} has no endmodule`, name));
      cursor = end;
      continue;
    }

    const body = tokens.slice(headerEnd + 1, end);
    const declarations = [];
    const assignments = [];
    const header = tokens.slice(cursor + 2, headerEnd);
    for (const headerToken of header) {
      if (['#', 'parameter', 'localparam'].includes(headerToken.text)) {
        diagnostics.push(diagnostic('RTL_PARAMETER_UNSUPPORTED', 'Parameterized modules are outside this compiler subset', headerToken));
      }
    }
    const portGroups = [];
    let portGroup = [];
    let portBracketDepth = 0;
    for (const headerToken of header) {
      if (headerToken.text === '(' || headerToken.text === ')') continue;
      if (headerToken.text === '[') portBracketDepth += 1;
      if (headerToken.text === ']') portBracketDepth -= 1;
      if (headerToken.text === ',' && portBracketDepth === 0) {
        if (portGroup.length) portGroups.push(portGroup);
        portGroup = [];
      } else {
        portGroup.push(headerToken);
      }
    }
    if (portGroup.length) portGroups.push(portGroup);
    let inheritedDirection = null;
    const undeclaredHeaderPorts = [];
    for (const group of portGroups) {
      const directionToken = group.find((item) => ['input', 'output', 'inout'].includes(item.text));
      if (directionToken) inheritedDirection = directionToken.text;
      const portName = [...group].reverse().find((item) =>
        item.kind === 'identifier' && !['input', 'output', 'inout', 'wire', 'reg', 'logic', 'signed', 'unsigned'].includes(item.text)
      );
      if (portName && !inheritedDirection) {
        undeclaredHeaderPorts.push(portName);
      } else if (portName) {
        if (group.some((item) => item.text === '[')) {
          diagnostics.push(diagnostic('RTL_PORT_WIDTH_UNSUPPORTED', 'Packed port widths are outside this compiler subset', portName));
        }
        const supportedPortTypes = new Set(['input', 'output', 'inout', 'wire', 'reg', 'logic', 'signed', 'unsigned']);
        const unsupportedType = group.find((item) => item.kind === 'identifier' && item !== portName && !supportedPortTypes.has(item.text));
        if (unsupportedType) {
          diagnostics.push(diagnostic('RTL_PORT_TYPE_UNSUPPORTED', `Port type ${unsupportedType.text} is outside this compiler subset`, unsupportedType));
        }
        declarations.push({
          name: portName.text,
          kind: inheritedDirection,
          location: { file: portName.file, line: portName.line, column: portName.column }
        });
      }
    }

    for (let position = 0; position < body.length; position += 1) {
      const bodyToken = body[position];
      if (['input', 'output', 'inout', 'wire', 'reg', 'logic'].includes(bodyToken.text)) {
        let declarationEnd = position + 1;
        let bracketDepth = 0;
        while (declarationEnd < body.length) {
          if (body[declarationEnd].text === '[') bracketDepth += 1;
          if (body[declarationEnd].text === ']') bracketDepth -= 1;
          if (body[declarationEnd].text === ';' && bracketDepth === 0) break;
          declarationEnd += 1;
        }
        if (declarationEnd === body.length) {
          diagnostics.push(diagnostic('RTL_DECLARATION_TERMINATOR_EXPECTED', 'Declaration is missing a semicolon', bodyToken));
          break;
        }
        const declarationTokens = body.slice(position + 1, declarationEnd);
        const declaredNames = declarationTokens.filter((item) => item.kind === 'identifier' && item.text !== 'signed' && item.text !== 'unsigned');
        if (declarationTokens.some((item) => item.text === '[')) {
          diagnostics.push(diagnostic('RTL_SIGNAL_WIDTH_UNSUPPORTED', 'Packed signal widths are outside this compiler subset', bodyToken));
        }
        if (declaredNames.length === 0) diagnostics.push(diagnostic('RTL_DECLARATION_NAME_EXPECTED', 'Declaration must name at least one signal', bodyToken));
        for (const declared of declaredNames) {
          declarations.push({ name: declared.text, kind: bodyToken.text, location: { file: declared.file, line: declared.line, column: declared.column } });
        }
        position = declarationEnd;
      } else if (bodyToken.text === 'assign') {
        let assignmentEnd = position + 1;
        while (assignmentEnd < body.length && body[assignmentEnd].text !== ';') assignmentEnd += 1;
        if (assignmentEnd === body.length) {
          diagnostics.push(diagnostic('RTL_ASSIGN_TERMINATOR_EXPECTED', 'Continuous assignment is missing a semicolon', bodyToken));
          break;
        }
        const expression = body.slice(position + 1, assignmentEnd);
        const equalsIndex = expression.findIndex((item) => item.text === '=');
        if (equalsIndex < 1 || equalsIndex === expression.length - 1) {
          diagnostics.push(diagnostic('RTL_ASSIGNMENT_INVALID', 'Expected a non-empty continuous assignment', bodyToken));
        } else {
          assignments.push({
            target: expression[0].text,
            expression: expression.slice(equalsIndex + 1).map((item) => item.text).join(' '),
            location: { file: bodyToken.file, line: bodyToken.line, column: bodyToken.column }
          });
        }
        position = assignmentEnd;
      } else if (bodyToken.text === '=') {
        diagnostics.push(diagnostic('RTL_PROCEDURAL_ASSIGNMENT_UNSUPPORTED', 'Procedural constructs are outside this compiler subset', bodyToken));
      } else if (bodyToken.kind === 'identifier' || bodyToken.kind === 'keyword') {
        diagnostics.push(diagnostic('RTL_CONSTRUCT_UNSUPPORTED', `Construct ${bodyToken.text} is outside this compiler subset`, bodyToken));
        while (position + 1 < body.length && body[position + 1].text !== ';') position += 1;
      }
    }

    const names = new Set(declarations.map((item) => item.name));
    for (const port of undeclaredHeaderPorts) {
      if (!declarations.some((item) => item.name === port.text && ['input', 'output', 'inout'].includes(item.kind))) {
        diagnostics.push(diagnostic('RTL_PORT_DECLARATION_MISSING', `Non-ANSI port ${port.text} requires an input/output/inout declaration`, port));
      }
    }
    for (const assignment of assignments) {
      if (!names.has(assignment.target)) diagnostics.push(diagnostic('RTL_UNDECLARED_ASSIGNMENT_TARGET', `Assignment target ${assignment.target} is not declared`, assignment.location));
    }
    for (const assignment of assignments) {
      const expressionTokens = body.filter((item) => item.file === assignment.location.file && item.line === assignment.location.line);
      for (const item of expressionTokens) {
        if (item.kind === 'identifier' && !names.has(item.text) && !keywords.has(item.text) && item.text !== assignment.target) {
          diagnostics.push(diagnostic('RTL_UNDECLARED_SIGNAL', `Signal ${item.text} is not declared`, item));
        }
      }
    }

    modules.push({
      name: name.text,
      location: { file: name.file, line: name.line, column: name.column },
      ports: declarations.filter((item) => ['input', 'output', 'inout'].includes(item.kind)),
      signals: declarations.filter((item) => ['wire', 'reg', 'logic'].includes(item.kind)),
      assignments
    });
    cursor = end + 1;
  }

  if (modules.length === 0) diagnostics.push(diagnostic('RTL_MODULE_REQUIRED', 'No module declaration was found'));
  const moduleNames = new Set();
  for (const module of modules) {
    if (moduleNames.has(module.name)) diagnostics.push(diagnostic('RTL_DUPLICATE_MODULE', `Duplicate module ${module.name}`, module.location));
    moduleNames.add(module.name);
  }
  if (topModule && !modules.some((module) => module.name === topModule)) {
    diagnostics.push(diagnostic('RTL_TOP_MODULE_NOT_FOUND', `Selected top module ${topModule} was not found in the compiled RTL`));
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const ir = {
    format: 'aura-ir-json',
    schemaVersion: 1,
    compilerVersion,
    projectVersionId,
    topModule: topModule || (modules.length === 1 ? modules[0].name : null),
    modules
  };
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
  };
  const hashInput = { ...ir };
  delete hashInput.projectVersionId;
  const canonicalIr = `${JSON.stringify(canonicalize(hashInput))}\n`;
  const hash = createHash('sha256').update(canonicalIr).digest('hex');
  return {
    ok: true,
    diagnostics: [],
    ir: { ...ir, designHash: hash },
    tokenCount: tokens.length,
    artifact: Buffer.from(`${JSON.stringify({ ...ir, designHash: hash }, null, 2)}\n`)
  };
}
