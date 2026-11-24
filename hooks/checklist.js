'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EVENT = String(process.argv[2] || '').toLowerCase();
const HOOK_DIR = __dirname;
const MAX_TOOLS = 200;

const DEFAULT_CONFIG = {
  sendToModel: true,
  maxEntries: 6,
  checklist: [
    '只改动与任务相关的文件/目录',
    '写、删、推送、安装等有副作用的操作先确认影响面',
    '改动后按项目规则验证（不擅自编译、不擅自推送）'
  ]
};

const CONFIG = loadConfig();

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(HOOK_DIR, 'config.json'), 'utf8'));
    return Object.assign({}, DEFAULT_CONFIG, parsed);
  } catch (_) {
    return DEFAULT_CONFIG;
  }
}

function emit(payload) {
  try {
    fs.writeSync(1, JSON.stringify(payload));
  } catch (_) {}
  process.exit(0);
}

function exitSilently() {
  process.exit(0);
}

function stateDirectory() {
  return process.env.PLUGIN_DATA || path.join(os.homedir(), '.agy-progress-checklist');
}

function stateFile(payload) {
  const id = typeof payload.conversationId === 'string' ? payload.conversationId : '';
  const key = id
    ? id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
    : 'cwd-' + crypto.createHash('sha1').update(String(payload.cwd || process.cwd())).digest('hex').slice(0, 12);
  return path.join(stateDirectory(), key + '.json');
}

function freshState(payload) {
  return {
    conversationId: payload.conversationId || '',
    lastUserInput: typeof payload.lastUserInput === 'string' ? payload.lastUserInput : '',
    cwd: payload.cwd || process.cwd(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalCalls: 0,
    okCount: 0,
    failCount: 0,
    newCalls: 0,
    reported: false,
    tools: [],
    projectChecklist: null
  };
}

function loadState(payload) {
  const file = stateFile(payload);
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    state = null;
  }

  const input = typeof payload.lastUserInput === 'string' ? payload.lastUserInput : '';
  if (!state || !Array.isArray(state.tools)) {
    state = freshState(payload);
  } else if (input && input !== state.lastUserInput && state.tools.length > 0) {
    state = freshState(payload);
  }

  if (input) state.lastUserInput = input;
  if (payload.cwd) state.cwd = payload.cwd;
  state.file = file;
  return state;
}

function saveState(state) {
  const file = state.file;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    state.updatedAt = Date.now();
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) {
    return;
  }
  if (Math.random() < 0.05) pruneStateFiles(path.dirname(file));
}

function pruneStateFiles(dir) {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (_) {}
    }
  } catch (_) {}
}

function callId(call, stepIdx) {
  if (call && call.id) return String(call.id);
  if (stepIdx !== undefined && stepIdx !== null) return 'step-' + stepIdx;
  return 'call-' + Date.now();
}

function findEntry(state, id) {
  for (let i = state.tools.length - 1; i >= 0; i -= 1) {
    if (state.tools[i] && state.tools[i].id === id) return state.tools[i];
  }
  return null;
}

function trimTools(state) {
  if (state.tools.length > MAX_TOOLS) {
    state.tools.splice(0, state.tools.length - MAX_TOOLS);
  }
}

function summarizeCall(call) {
  const name = call && call.name ? String(call.name) : 'tool';
  const args = call && call.args && typeof call.args === 'object' ? call.args : {};
  const preferred = [
    'CommandLine', 'command', 'cmd',
    'TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchPath', 'path', 'file_path',
    'Query', 'query', 'Pattern', 'pattern', 'Url', 'url', 'prompt'
  ];
  let detail = '';
  for (const key of preferred) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      detail = args[key];
      break;
    }
  }
  if (!detail) {
    for (const key of Object.keys(args)) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        detail = value;
        break;
      }
    }
  }
  return { name, detail: truncate(collapse(detail), 80) };
}

function handlePreToolUse(payload) {
  const state = loadState(payload);
  const call = payload.toolCall || {};
  const id = callId(call, payload.stepIdx);
  const info = summarizeCall(call);
  let entry = findEntry(state, id);

  if (!entry) {
    state.totalCalls += 1;
    entry = {
      id,
      seq: state.totalCalls,
      name: info.name,
      detail: info.detail,
      status: 'running',
      startedAt: Date.now()
    };
    state.tools.push(entry);
    trimTools(state);
    state.newCalls += 1;
  } else {
    entry.name = info.name;
    entry.detail = info.detail;
    entry.status = 'running';
    entry.startedAt = entry.startedAt || Date.now();
  }

  saveState(state);
  exitSilently();
}

function handlePostToolUse(payload) {
  const state = loadState(payload);
  const call = payload.toolCall || {};
  const id = callId(call, payload.stepIdx);
  const failed = Boolean(payload.error);
  let entry = findEntry(state, id);

  if (!entry) {
    state.totalCalls += 1;
    const info = summarizeCall(call);
    entry = {
      id,
      seq: state.totalCalls,
      name: info.name,
      detail: info.detail,
      startedAt: Date.now()
    };
    state.tools.push(entry);
    trimTools(state);
    state.newCalls += 1;
  }

  entry.status = failed ? 'failed' : 'done';
  entry.endedAt = Date.now();
  if (failed) {
    entry.error = truncate(collapse(String(payload.error)), 120);
    state.failCount += 1;
  } else {
    state.okCount += 1;
  }

  saveState(state);
  emit({});
}

function handlePreInvocation(payload) {
  const state = loadState(payload);

  if (state.reported && !(state.newCalls > 0)) {
    saveState(state);
    emit({});
    return;
  }

  state.reported = true;
  state.newCalls = 0;
  const ctx = buildContext(state);
  saveState(state);

  emit({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: CONFIG.sendToModel ? renderModelText(state, ctx) : '',
          renderInfo: {
            title: '进度检查表',
            titlePrefix: '🧭',
            markdown: renderUserMarkdown(state, ctx)
          }
        }
      }
    ]
  });
}

function buildContext(state) {
  const items = projectChecklist(state) || CONFIG.checklist;
  const max = Math.max(1, Number(CONFIG.maxEntries) || 6);
  const recent = state.tools.slice(-max);
  return {
    items,
    recent,
    hidden: Math.max(0, state.tools.length - recent.length),
    ok: state.okCount,
    fail: state.failCount,
    running: state.tools.filter(function (t) { return t && t.status === 'running'; }).length,
    last: state.tools.length ? state.tools[state.tools.length - 1] : null,
    total: state.totalCalls
  };
}

function renderUserMarkdown(state, ctx) {
  const lines = [];
  const task = truncate(collapse(state.lastUserInput), 60);

  if (ctx.total === 0) {
    if (task) lines.push('🧭 **任务**：' + task);
    lines.push('📋 **调用前检查表**');
    ctx.items.forEach(function (item) { lines.push('- ☐ ' + item); });
    return lines.join('\n');
  }

  const head = ['🧭 **第 ' + ctx.total + ' 次工具调用**', '✅ ' + ctx.ok];
  if (ctx.fail) head.push('❌ ' + ctx.fail);
  if (ctx.running) head.push('▶ ' + ctx.running);
  lines.push(head.join(' · '));
  if (ctx.hidden) lines.push('- … 另有 ' + ctx.hidden + ' 次调用');
  ctx.recent.forEach(function (t) { lines.push(renderToolLine(t)); });
  lines.push('📋 **检查表**：' + ctx.items.map(function (i) { return '☐ ' + i; }).join(' · '));
  return lines.join('\n');
}

function renderToolLine(t) {
  const icon = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : '▶';
  let line = '- ' + icon + ' #' + t.seq + ' `' + t.name + '`';
  if (t.detail) line += ' — ' + t.detail;
  if (t.status === 'failed' && t.error) line += '（' + t.error + '）';
  return line;
}

function renderModelText(state, ctx) {
  if (ctx.total === 0) {
    return '[检查表] 开始前自检：' + ctx.items.join('；') + '。';
  }
  const last = ctx.last ? ctx.last.name + '（' + ctx.last.status + '）' : '无';
  return '[进度] 第 ' + ctx.total + ' 次工具调用：成功 ' + ctx.ok + '，失败 ' + ctx.fail +
    '。最近：' + last + '。调用工具前自检：' + ctx.items.join('；') + '。';
}

function projectChecklist(state) {
  const now = Date.now();
  const cached = state.projectChecklist;
  if (cached && typeof cached.at === 'number' && now - cached.at < 5000) {
    return cached.items || null;
  }
  const file = findChecklistFile(state.cwd);
  const items = file ? parseChecklistFile(file) : null;
  state.projectChecklist = { at: now, file: file || '', items: items || null };
  return items;
}

function findChecklistFile(cwd) {
  let dir = cwd;
  for (let depth = 0; depth < 12 && dir; depth += 1) {
    const candidates = [
      path.join(dir, '.agents', 'checklist.json'),
      path.join(dir, '.agents', 'checklist.md')
    ];
    for (const file of candidates) {
      if (isFile(file)) return file;
    }
    if (isDirectory(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return '';
}

function parseChecklistFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (/\.json$/i.test(file)) {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return normalizeItems(data);
      if (data && Array.isArray(data.items)) return normalizeItems(data.items);
      return null;
    }
    const items = raw.split(/\r?\n/)
      .map(function (line) { return line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.*)$/); })
      .filter(Boolean)
      .map(function (match) { return match[1]; });
    return normalizeItems(items);
  } catch (_) {
    return null;
  }
}

function normalizeItems(list) {
  if (!Array.isArray(list)) return null;
  const items = list
    .map(function (v) { return collapse(String(v == null ? '' : v)); })
    .filter(Boolean)
    .map(function (v) { return truncate(v, 80); })
    .slice(0, 8);
  return items.length ? items : null;
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch (_) { return false; }
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch (_) { return false; }
}

function collapse(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  const text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function readPayload() {
  return new Promise(function (resolve) {
    let raw = '';
    let finished = false;
    const finish = function () {
      if (finished) return;
      finished = true;
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { payload = {}; }
      resolve(payload);
    };
    const timer = setTimeout(finish, 800);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', function (chunk) {
        raw += chunk;
        if (raw.length > 2000000) raw = raw.slice(-2000000);
      });
      process.stdin.on('error', finish);
      process.stdin.on('end', function () {
        clearTimeout(timer);
        finish();
      });
    } catch (_) {
      clearTimeout(timer);
      finish();
    }
  });
}

async function main() {
  const payload = await readPayload();
  switch (EVENT) {
    case 'pre-tool-use':
      handlePreToolUse(payload);
      return;
    case 'post-tool-use':
      handlePostToolUse(payload);
      return;
    case 'pre-invocation':
      handlePreInvocation(payload);
      return;
    default:
      emit({});
  }
}

main().catch(function () {
  if (EVENT === 'pre-tool-use') exitSilently();
  else emit({});
});
