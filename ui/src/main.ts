/// <reference types="@angular/localize" />

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// A cached offline shell can keep an obsolete UI active after a local upgrade.
// MeTube is server-backed, so always prefer the version currently being served.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) =>
    Promise.all(registrations.map((registration) => registration.unregister())),
  );
}

if ('caches' in window) {
  void caches.keys().then((keys) =>
    Promise.all(keys.filter((key) => key.startsWith('ngsw:')).map((key) => caches.delete(key))),
  );
}

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
