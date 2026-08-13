#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.argv[2] || 'http://localhost:8081/?ui-audit=1';
const port = 9333;
const profile = await mkdtemp(join(tmpdir(), 'metube-ui-audit-'));
const sampleMedia = join(profile, 'entrevista-auditoria.mp3');
await writeFile(sampleMedia, Buffer.from('ID3'));
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-background-networking',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=1365,900',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();
const browserErrors = [];

async function command(method, params = {}) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const response = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.result.value;
}

async function connect() {
  let tabs;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!tabs) throw new Error('Chrome DevTools não iniciou');
  const page = tabs.find((tab) => tab.type === 'page' && tab.url === 'about:blank');
  if (!page) throw new Error('Página de auditoria do Chrome não encontrada');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', async (event) => {
    const payload = typeof event.data === 'string' ? event.data : await event.data.text();
    const message = JSON.parse(payload);
    if (!message.id) {
      if (message.method === 'Runtime.exceptionThrown') {
        browserErrors.push(message.params.exceptionDetails.text || 'Exceção JavaScript');
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        browserErrors.push(message.params.entry.text);
      }
      return;
    }
    if (!pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message);
  });
}

async function auditViewport(width, height, label) {
  await command('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await command('Page.navigate', { url: baseUrl });
  await sleep(1800);
  const result = await evaluate(`(async () => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const transcriptionTab = tabs.find((tab) => tab.textContent.trim() === 'Transcrever');
    if (transcriptionTab) transcriptionTab.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const workspace = document.querySelector('.transcription-workspace');
    const picker = workspace?.querySelector('input[type="file"]');
    const pickerButton = workspace?.querySelector('label[for="transcription-file"]');
    const cards = [...(workspace?.querySelectorAll('.ant-card') || [])];
    const workspaceRect = workspace?.getBoundingClientRect();
    const buttonRect = pickerButton?.getBoundingClientRect();
    const cardRects = cards.map((card) => card.getBoundingClientRect());
    return {
      selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(),
      workspaceVisible: visible(workspace),
      workspaceHeight: workspaceRect?.height || 0,
      workspaceText: workspace?.textContent.replace(/\\s+/g, ' ').trim() || '',
      pickerExists: Boolean(picker),
      pickerEnabled: Boolean(picker && !picker.disabled),
      pickerAccept: picker?.accept || '',
      pickerButtonVisible: visible(pickerButton),
      pickerButtonText: pickerButton?.textContent.replace(/\\s+/g, ' ').trim() || '',
      pickerButtonWidth: buttonRect?.width || 0,
      cardsVisible: cards.filter(visible).length,
      horizontalOverflow: [...document.querySelectorAll('body *')]
        .some((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return style.position !== 'absolute' && (rect.right > innerWidth + 1 || rect.left < -1);
        }),
      overflowWidth: document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth,
      overflowElements: [...document.querySelectorAll('body *')]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return getComputedStyle(element).position !== 'absolute' && (rect.right > innerWidth + 1 || rect.left < -1);
        })
        .slice(0, 8)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return element.tagName.toLowerCase() + '.' + [...element.classList].join('.') + '@' +
            Math.round(rect.left) + '..' + Math.round(rect.right);
        }),
      cardsInsideViewport: cardRects.every((rect) => rect.left >= -1 && rect.right <= innerWidth + 1),
    };
  })()`);

  const documentNode = await command('DOM.getDocument', { depth: -1, pierce: true });
  const inputNode = await command('DOM.querySelector', {
    nodeId: documentNode.result.root.nodeId,
    selector: '#transcription-file',
  });
  if (inputNode.result.nodeId) {
    await command('DOM.setFileInputFiles', {
      nodeId: inputNode.result.nodeId,
      files: [sampleMedia],
    });
    await sleep(300);
  }
  const selection = await evaluate(`(() => {
    const workspace = document.querySelector('.transcription-workspace');
    const action = [...(workspace?.querySelectorAll('button') || [])]
      .find((button) => button.textContent.includes('Transcrever arquivo'));
    const remove = [...(workspace?.querySelectorAll('button') || [])]
      .find((button) => button.textContent.includes('Remover'));
    const selectedNameVisible = workspace?.textContent.includes('entrevista-auditoria.mp3') || false;
    const actionEnabled = Boolean(action && !action.disabled);
    const removeVisible = Boolean(remove && getComputedStyle(remove).display !== 'none');
    if (remove) remove.click();
    return { selectedNameVisible, actionEnabled, removeVisible };
  })()`);
  await sleep(200);
  const removal = await evaluate(`(() => ({
    nameCleared: !document.querySelector('.transcription-workspace')?.textContent.includes('entrevista-auditoria.mp3'),
    inputCleared: !document.querySelector('#transcription-file')?.files?.length,
  }))()`);
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const screenshotPath = `/tmp/metube-transcription-audit-${label}.png`;
  await writeFile(screenshotPath, Buffer.from(screenshot.result.data, 'base64'));

  const failures = [];
  if (result.selectedTab !== 'Transcrever') failures.push('aba Transcrever não ficou selecionada');
  if (!result.workspaceVisible || result.workspaceHeight < 250) failures.push('conteúdo da aba está oculto ou colapsado');
  if (!result.workspaceText.includes('Arquivo deste computador')) failures.push('seção de arquivo não foi renderizada');
  if (!result.pickerExists || !result.pickerEnabled) failures.push('input file está ausente ou desabilitado');
  if (!result.pickerAccept.includes('video/')) failures.push('input file não aceita vídeo');
  if (!result.pickerButtonVisible || result.pickerButtonWidth < 100) failures.push('controle Selecionar arquivo não está visível/acionável');
  if (result.cardsVisible < 2) failures.push('cartões principais não estão visíveis');
  if (result.horizontalOverflow || !result.cardsInsideViewport) failures.push('layout transborda horizontalmente');
  if (!selection.selectedNameVisible) failures.push('seleção real não exibe o nome do arquivo');
  if (!selection.actionEnabled) failures.push('botão de transcrição não habilita após selecionar arquivo');
  if (!selection.removeVisible || !removal.nameCleared || !removal.inputCleared) failures.push('remoção não limpa a seleção');
  return { label, viewport: `${width}x${height}`, ...result, ...selection, ...removal,
    screenshot: screenshotPath, failures };
}

try {
  await connect();
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Log.enable');
  await command('Network.enable');
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  await command('Network.setBypassServiceWorker', { bypass: true });
  const reports = [
    await auditViewport(1365, 900, 'desktop'),
    await auditViewport(390, 844, 'mobile'),
  ];
  if (browserErrors.length) reports[0].failures.push(`console do navegador: ${browserErrors.join('; ')}`);
  console.log(JSON.stringify(reports, null, 2));
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.label}: ${failure}`));
  if (failures.length) {
    console.error(`AUDITORIA REPROVADA\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('AUDITORIA APROVADA');
  }
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
}
