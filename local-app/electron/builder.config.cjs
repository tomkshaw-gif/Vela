const path = require('node:path');

module.exports = {
    appId: 'com.tomkshaw.vela', productName: 'Vela', executableName: 'Vela',
    electronVersion: require('../../package.json').devDependencies.electron,
    directories: { app: path.join(__dirname, 'staging/app'), output: path.join(__dirname, 'releases'), buildResources: path.join(__dirname, 'staging/icons') },
    files: ['*.cjs', 'package.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt', '!**/node_modules{,/**/*}'],
    extraResources: [{ from: path.join(__dirname, 'staging/app-runtime'), to: 'app-runtime', filter: ['server.mjs', 'backend.mjs', 'client/**/*'] }],
    asar: true, npmRebuild: false,
    artifactName: 'Vela-Setup-${version}.${ext}',
    win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(__dirname, 'staging/icons/icon.ico') },
    nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, createDesktopShortcut: 'always', shortcutName: 'Run Vela', uninstallDisplayName: 'Vela', runAfterFinish: false },
    publish: { provider: 'github', owner: 'tomkshaw-gif', repo: 'Vela', releaseType: 'release', tagNamePrefix: 'desktop-v' },
};
