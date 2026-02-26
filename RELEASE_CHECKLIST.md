# BANSOU-VSCode Release Checklist

## Preflight

- [ ] `npm ci`
- [ ] `cd ui && npm ci && npm run build`
- [ ] `npm run package`
- [ ] `npm run package:vsix`

## Metadata

- [ ] `package.json` の version 更新
- [ ] `CHANGELOG.md` 更新
- [ ] `publisher` が実公開アカウントと一致
- [ ] `icon` と README が Marketplace 表示に耐える内容

## Publish

- [ ] `VSCE_PAT` を GitHub Secrets に設定
- [ ] `.github/workflows/publish-extension.yml` を実行
- [ ] もしくはローカルで `npm run publish:marketplace`

## Post-release

- [ ] Marketplace から install できる
- [ ] clean環境で `BANSOU: Open Sidebar` が表示される
