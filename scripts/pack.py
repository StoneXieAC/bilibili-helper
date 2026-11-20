"""打包发布 zip（排除 test/node_modules 等）"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'bilibili-downloader.zip')

INCLUDE = {
    'THIRD_PARTY_NOTICES.md', 'lib/mp4-remux.LICENSE',
    'manifest.json', 'background.js',
    '_locales/zh_CN/messages.json', '_locales/en/messages.json',
    'content/page-agent.js', 'content/content.js', 'content/content.css',
    'shared/design-system.css', 'shared/ambient-themes.css', 'shared/theme-manager.js',
    'shared/themes-ambient-full.json', 'shared/i18n-languages.js', 'shared/i18n.js', 'shared/i18n-extra.js', 'shared/i18n-ja-ko.js', 'shared/filename.js', 'shared/download-settings.js',
    'shared/download-power.js',
    'popup/popup.html', 'popup/popup.js', 'popup/popup.css',
    'lib/mp4-remux.iife.js', 'lib/m4s-mux.js', 'lib/m4s-mux-worker.js',
    'icons/icon128.png', 'icons/icon48.png', 'icons/icon32.png', 'icons/icon16.png',
}

REQUIRED = set(INCLUDE)


def packaged_bytes(rel, path):
    with open(path, 'rb') as f:
        return f.read()


def main():
    missing = [rel for rel in sorted(REQUIRED) if not os.path.isfile(os.path.join(ROOT, rel.replace('/', os.sep)))]
    if missing:
        raise SystemExit('PACK FAIL missing required files:\n' + '\n'.join(missing))
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(INCLUDE):
            path = os.path.join(ROOT, rel.replace('/', os.sep))
            zf.writestr(rel, packaged_bytes(rel, path))
            print('ADD:', rel)
    print('OK ->', OUT)

if __name__ == '__main__':
    main()
