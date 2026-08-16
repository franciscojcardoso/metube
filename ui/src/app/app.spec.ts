import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpEventType, HttpResponse } from '@angular/common/http';
import { Subject, of } from 'rxjs';
import { App } from './app';
import { DownloadsService } from './services/downloads.service';
import { SubscriptionsService } from './services/subscriptions.service';
import { ToastService } from './services/toast.service';
import { CookieService } from 'ngx-cookie-service';

class DownloadsServiceStub {
  loading = false;
  queue = new Map();
  done = new Map();
  configuration: Record<string, unknown> = { CUSTOM_DIRS: true, CREATE_CUSTOM_DIRS: true, ALLOW_YTDL_OPTIONS_OVERRIDES: false };
  customDirs = { download_dir: [], audio_download_dir: [] };
  queueChanged = new Subject<void>();
  doneChanged = new Subject<void>();
  configurationChanged = new Subject<Record<string, unknown>>();
  customDirsChanged = new Subject<Record<string, string[]>>();
  ytdlOptionsChanged = new Subject<Record<string, unknown>>();
  updated = new Subject<void>();
  retryCalls: string[] = [];
  transcriptionEvents = new Subject<unknown>();

  getCookieStatus() {
    return of({ status: 'ok', has_cookies: false });
  }

  getPresets() {
    return of({ presets: ['Preset A'] });
  }

  add() {
    return of({ status: 'ok' as const });
  }

  retry(id: string) {
    this.retryCalls.push(id);
    return of({ status: 'ok' as const });
  }

  cancelAdd() {
    return of({ status: 'ok' as const });
  }

  startById() {
    return of({});
  }

  delById() {
    return of({});
  }

  delByFilter() {
    return of({});
  }

  startByFilter() {
    return of({});
  }

  uploadCookies() {
    return of({ status: 'ok' });
  }

  transcribeUpload() {
    return this.transcriptionEvents.asObservable();
  }

  deleteCookies() {
    return of({ status: 'ok' });
  }
}

class SubscriptionsServiceStub {
  subscriptions = new Map();
  subscriptionsChanged = new Subject<void>();
  subscribeCalls: unknown[] = [];

  subscribe(payload: unknown) {
    this.subscribeCalls.push(payload);
    return of({ status: 'ok' as const });
  }

  delete() {
    return of({});
  }

  updateCalls: [string, unknown][] = [];

  update(id: string, changes: unknown) {
    this.updateCalls.push([id, changes]);
    return of({ status: 'ok' as const });
  }

  refreshList() {
    return of([]);
  }
}

class CookieServiceStub {
  private cookies = new Map<string, string>();

  get(name: string) {
    return this.cookies.get(name) ?? '';
  }

  set(name: string, value: string) {
    this.cookies.set(name, value);
  }

  check(name: string) {
    return this.cookies.has(name);
  }
}

describe('App', () => {
  let downloads: DownloadsServiceStub;

  beforeEach(async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      enumerable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    downloads = new DownloadsServiceStub();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: DownloadsService, useValue: downloads },
        { provide: SubscriptionsService, useClass: SubscriptionsServiceStub },
        { provide: CookieService, useClass: CookieServiceStub },
        {
          provide: HttpClient,
          useValue: {
            get: vi.fn().mockReturnValue(of({ 'yt-dlp': 'test', version: 'test' })),
          },
        },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('asIsOrder returns a stable comparator value (insertion order preserved)', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app.asIsOrder()).toBe(0);
  });

  it('hides manual override input when disabled', () => {
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.isAdvancedOpen = true;
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('input[name="ytdlOptionsOverrides"]')).toBeNull();

    const presetWrapper = root.querySelector('ng-select[name="ytdlOptionsPresets"]')?.closest('.col-12');
    expect(presetWrapper?.classList.contains('col-md-6')).toBe(false);

    const presetRow = root.querySelector('ng-select[name="ytdlOptionsPresets"]')?.closest('.row');
    expect(presetRow?.querySelector('input[name="checkIntervalMinutes"]')).toBeNull();
  });

  it('shows manual override input when enabled', () => {
    downloads.configuration['ALLOW_YTDL_OPTIONS_OVERRIDES'] = true;

    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.isAdvancedOpen = true;
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('input[name="ytdlOptionsOverrides"]')).not.toBeNull();

    const presetWrapper = root.querySelector('ng-select[name="ytdlOptionsPresets"]')?.closest('.col-12');
    expect(presetWrapper?.classList.contains('col-md-6')).toBe(true);

    const presetRow = root.querySelector('ng-select[name="ytdlOptionsPresets"]')?.closest('.row');
    expect(presetRow?.querySelector('input[name="checkIntervalMinutes"]')).toBeNull();
    expect(presetRow?.querySelector('input[name="ytdlOptionsOverrides"]')).not.toBeNull();
  });

  it('does not submit manual overrides when disabled', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;

    app.ytdlOptionsOverrides = '{"exec":"echo hi"}';

    const payload = app['buildAddPayload']();

    expect(payload.ytdlOptionsOverrides).toBe('');
  });

  it('shows waiting badge for scheduled live stream', () => {
    downloads.queue.set('https://example.com/live', {
      id: 'live1',
      title: 'Upcoming Stream',
      url: 'https://example.com/live',
      download_type: 'video',
      quality: 'best',
      format: 'any',
      folder: '',
      custom_name_prefix: '',
      playlist_item_limit: 0,
      status: 'scheduled',
      live_status: 'is_upcoming',
      live_release_timestamp: Date.now() / 1000 + 3600,
      msg: '',
      percent: 0,
      speed: 0,
      eta: 0,
      filename: '',
      checked: false,
    });
    downloads.queueChanged.next();

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Aguardando transmissão');
    expect(root.textContent).toContain('começa em');
  });

  it('includes titleRegex in subscribe payload', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    const subs = TestBed.inject(SubscriptionsService) as unknown as SubscriptionsServiceStub;
    app.addUrl = 'https://example.com/channel';
    app.titleRegex = 'EPISODE';
    app.addSubscription();
    expect(subs.subscribeCalls.length).toBe(1);
    const payload = subs.subscribeCalls[0] as { titleRegex: string; skipSubscriberOnly: boolean };
    expect(payload.titleRegex).toBe('EPISODE');
    expect(payload.skipSubscriberOnly).toBe(false);
  });

  it('includes skipSubscriberOnly true when checked', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    const subs = TestBed.inject(SubscriptionsService) as unknown as SubscriptionsServiceStub;
    app.addUrl = 'https://example.com/channel';
    app.skipSubscriberOnly = true;
    app.addSubscription();
    expect(subs.subscribeCalls.length).toBe(1);
    const payload = subs.subscribeCalls[0] as { skipSubscriberOnly: boolean };
    expect(payload.skipSubscriberOnly).toBe(true);
  });

  it('omits clip fields from subscribe payload', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    const subs = TestBed.inject(SubscriptionsService) as unknown as SubscriptionsServiceStub;
    app.addUrl = 'https://example.com/channel';
    app.clipStart = '1:00';
    app.clipEnd = '2:00';
    app.addSubscription();
    expect(subs.subscribeCalls.length).toBe(1);
    const payload = subs.subscribeCalls[0] as Record<string, unknown>;
    expect('clipStart' in payload).toBe(false);
    expect('clipEnd' in payload).toBe(false);
  });

  it('buildAddPayload includes clip times', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.clipStart = '0:10';
    app.clipEnd = '1:20';
    const payload = app['buildAddPayload']();
    expect(payload.clipStart).toBe('0:10');
    expect(payload.clipEnd).toBe('1:20');
  });

  it('retries a failed download by its server-side queue id', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    const download = {
      id: 'vid1',
      title: 'Test Video',
      url: 'https://example.com/v',
      download_type: 'video',
      quality: 'best',
      format: 'any',
      folder: '',
      custom_name_prefix: '',
      playlist_item_limit: 0,
      status: 'error',
      msg: 'temporary failure',
      percent: 0,
      speed: 0,
      eta: 0,
      filename: '',
      checked: false,
    };

    app.retryDownload(download.url, download);

    expect(downloads.retryCalls).toEqual([download.url]);
  });

  it('blocks subscribe with invalid title regex', () => {
    const toasts = TestBed.inject(ToastService);
    const errorSpy = vi.spyOn(toasts, 'error').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    const subs = TestBed.inject(SubscriptionsService) as unknown as SubscriptionsServiceStub;
    app.addUrl = 'https://example.com/channel';
    app.titleRegex = '[';
    app.addSubscription();
    expect(subs.subscribeCalls.length).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith('Invalid subscription title filter (regex)');
    errorSpy.mockRestore();
  });

  it('renames a subscription and closes the inline editor', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    const subs = TestBed.inject(SubscriptionsService) as unknown as SubscriptionsServiceStub;

    app.beginEditName('sub1', 'Videos');
    expect(app.editingNameId).toBe('sub1');
    expect(app.nameEditDraft).toBe('Videos');

    app.nameEditDraft = '  Jane uploads  ';
    app.saveName('sub1');

    expect(subs.updateCalls).toEqual([['sub1', { name: 'Jane uploads' }]]);
    expect(app.editingNameId).toBeNull();
  });

  it('blocks renaming a subscription to an empty name', () => {
    const toasts = TestBed.inject(ToastService);
    const errorSpy = vi.spyOn(toasts, 'error').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    const subs = TestBed.inject(SubscriptionsService) as unknown as SubscriptionsServiceStub;

    app.beginEditName('sub1', 'Videos');
    app.nameEditDraft = '   ';
    app.saveName('sub1');

    expect(subs.updateCalls.length).toBe(0);
    expect(app.editingNameId).toBe('sub1');
    expect(errorSpy).toHaveBeenCalledWith('Subscription name must not be empty');
    errorSpy.mockRestore();
  });

  it('shows an enabled native file picker when the transcription tab is clicked', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const transcriptionTab = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Transcrever'));
    expect(transcriptionTab).not.toBeUndefined();
    transcriptionTab?.click();
    fixture.detectChanges();

    const workspace = root.querySelector('.transcription-workspace');
    const fileInput = workspace?.querySelector<HTMLInputElement>('input[type="file"]');
    const pickerLabel = workspace?.querySelector<HTMLLabelElement>('label[for="transcription-file"]');
    expect(app.activeWorkspaceTab).toBe('transcribe');
    expect(workspace).not.toBeNull();
    expect(root.querySelector('#download-workspace')).toBeNull();
    expect(workspace?.textContent).toContain('Arquivo deste computador');
    expect(pickerLabel?.textContent).toContain('Abrir navegador de arquivos');
    expect(fileInput).not.toBeNull();
    expect(fileInput?.disabled).toBe(false);
    expect(fileInput?.id).toBe('transcription-file');
    expect(fileInput?.accept).toContain('video/*');

    const media = new File(['audio'], 'entrevista.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: { 0: media, length: 1, item: (index: number) => index === 0 ? media : null },
    });
    fileInput?.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(app.selectedTranscriptionFile).toBe(media);
    expect(workspace?.textContent).toContain('entrevista.mp3');
    expect(workspace?.textContent).toContain('Transcrever arquivo');
  });

  it('shows measured upload progress followed by a labelled transcription phase', () => {
    downloads.configuration['TRANSCRIPTION_ENABLED'] = true;
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.activeWorkspaceTab = 'transcribe';
    app.selectedTranscriptionFile = new File(['audio'], 'entrevista.mp3', { type: 'audio/mpeg' });
    fixture.detectChanges();

    app.transcribeSelectedFile();
    downloads.transcriptionEvents.next({ type: HttpEventType.UploadProgress, loaded: 40, total: 100 });
    fixture.detectChanges();

    let progress = fixture.nativeElement.querySelector('.transcription-progress') as HTMLElement;
    expect(progress.textContent).toContain('Enviando arquivo');
    expect(progress.textContent).toContain('40%');

    downloads.transcriptionEvents.next({ type: HttpEventType.UploadProgress, loaded: 100, total: 100 });
    fixture.detectChanges();
    progress = fixture.nativeElement.querySelector('.transcription-progress') as HTMLElement;
    expect(progress.textContent).toContain('Transcrevendo áudio');
    expect(progress.querySelector('.progress')?.classList.contains('progress-indeterminate')).toBe(true);

    downloads.transcriptionEvents.next(new HttpResponse({
      body: { status: 'ok', result: { markdown: '/downloads/entrevista.md' } },
    }));
    downloads.transcriptionEvents.complete();
    fixture.detectChanges();
    expect(app.selectedTranscriptionFile).toBeNull();
    expect(app.localTranscriptionInProgress).toBe(false);
    const result = fixture.nativeElement.querySelector('.transcription-result') as HTMLElement;
    expect(result.textContent).toContain('Transcrição concluída');
    expect(result.textContent).toContain('/downloads/entrevista.md');
  });

  it('keeps a visible error message after transcription fails', () => {
    downloads.configuration['TRANSCRIPTION_ENABLED'] = true;
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.activeWorkspaceTab = 'transcribe';
    app.selectedTranscriptionFile = new File(['audio'], 'falha.mp3', { type: 'audio/mpeg' });
    fixture.detectChanges();

    app.transcribeSelectedFile();
    downloads.transcriptionEvents.next(new HttpResponse({
      body: { status: 'error', msg: 'O servidor de transcrição não respondeu.' },
    }));
    downloads.transcriptionEvents.complete();
    fixture.detectChanges();

    const result = fixture.nativeElement.querySelector('.transcription-result') as HTMLElement;
    expect(result.textContent).toContain('Não foi possível transcrever o arquivo');
    expect(result.textContent).toContain('O servidor de transcrição não respondeu.');
    expect(app.selectedTranscriptionFile?.name).toBe('falha.mp3');
  });

  it('describes Markdown as the only transcription output', () => {
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.activeWorkspaceTab = 'transcribe';
    fixture.detectChanges();
    const workspace = fixture.nativeElement.querySelector('.transcription-workspace') as HTMLElement;
    expect(workspace.textContent).toContain('Markdown com metadados YAML');
    expect(workspace.textContent).not.toContain('SRT');
    expect(workspace.textContent).not.toContain('TXT');
    expect(workspace.textContent).not.toContain('JSON');
  });
});
