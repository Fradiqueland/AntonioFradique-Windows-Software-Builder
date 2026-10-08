'use strict';

// APK execution is deliberately unavailable until a complete, redistributable
// runtime has passed the native Builder AND exported Viewer acceptance tests.
// A PATH executable, SDK directory, environment flag or hand-edited project
// must never turn this information-only option into an external-emulator flow.
const ANDROID_RUNTIME_CODE = 'ANDROID_RUNTIME_NOT_INCLUDED';
const APK_TYPES = new Set(['apk', 'android-apk']);

const ANDROID_NOTICES = Object.freeze({
  pt: Object.freeze({
    creator: 'A execução de APK ainda não está disponível nesta versão. O motor Android totalmente incorporado no construtor e nas aplicações exportadas está em avaliação; não é necessário instalar um emulador para usar os restantes módulos.',
    viewer: 'Esta aplicação contém uma referência a APK, mas este instalador não inclui um motor Android validado. A aplicação Android não pode ser executada. Contacte o autor para obter uma versão com os componentes necessários incorporados.',
    requirements: 'Quando estiver disponível, o módulo Android será ativado apenas nos projetos que importem APK e aumentará o tamanho do pacote, o consumo de memória e o espaço utilizado. A aceleração poderá exigir ativar a virtualização ou uma funcionalidade do Windows. Sem aceleração, o desempenho poderá ser reduzido. A compatibilidade dependerá da versão de Android, da arquitetura e dos serviços usados pela aplicação; nem todos os APK serão compatíveis.',
    ios: 'Ficheiros IPA de iPhone/iPad não são suportados. Este módulo não converte aplicações iOS em aplicações Windows ou Mac.'
  }),
  en: Object.freeze({
    creator: 'APK execution is not available in this release. An Android runtime fully included in both the Builder and exported applications is being evaluated; you do not need to install an emulator to use the other modules.',
    viewer: 'This application contains an APK reference, but this installer does not include a validated Android runtime. The Android application cannot run. Contact its author for a version with the required components included.',
    requirements: 'When available, the Android module will activate only for projects importing an APK and will increase package size, memory use and disk use. Acceleration may require enabling virtualization or a Windows feature. Performance without acceleration may be reduced. Compatibility depends on the Android version, architecture and services used by the application; not every APK will be compatible.',
    ios: 'iPhone/iPad IPA files are not supported. This module does not convert iOS applications into Windows or Mac applications.'
  })
});

function noticesFor(locale) {
  return ANDROID_NOTICES[String(locale || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt'];
}

function getAndroidRuntimeStatus({ audience = 'creator', locale = 'pt' } = {}) {
  const notices = noticesFor(locale);
  return Object.freeze({
    available: false,
    code: ANDROID_RUNTIME_CODE,
    message: audience === 'viewer' ? notices.viewer : notices.creator,
    requirements: notices.requirements,
    ios: notices.ios
  });
}

function hasAPKModules(config) {
  const modules = Array.isArray(config) ? config : config && config.content;
  return Array.isArray(modules) && modules.some(module => module && APK_TYPES.has(module.type));
}

// Reject before creating an output file. Never export an APK-only placeholder
// that cannot run on the recipient's computer without separate installations.
function assertAPKExport(config, options) {
  if (!hasAPKModules(config)) return;
  const status = getAndroidRuntimeStatus(options);
  const error = new Error(status.message);
  error.code = status.code;
  throw error;
}

module.exports = { ANDROID_RUNTIME_CODE, ANDROID_NOTICES, getAndroidRuntimeStatus, hasAPKModules, assertAPKExport };
