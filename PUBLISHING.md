# Publishing guide · 发布指南

> **安全提醒**：不要在 Issue、README、聊天里粘贴账号密码或 npm token。GitHub 用浏览器登录/设备授权/PAT，npm 用 `npm login`（浏览器 OAuth + 2FA）。
>
> **事实前提**：DeepSeek 官方**没有**第三方插件提交入口——官方仓库 `CONTRIBUTING.md` 明确写 *"we cannot accept external pull requests at the moment"*，且 GitHub API 显示 `has_issues=false`、`has_pull_requests=false`。官方给出的生态做法是：自己发插件、给仓库打 `dsh-plugin` topic、在 GitHub Discussions 交流。
> 第三方插件的真实分发链路是：**GitHub 公开仓库 → npm 包 → `awesome-dsh-plugin` 目录 PR → 网站 / dshmarket 自动收录（通常 1 天内）**。`dshmarket` 只是这个社区目录的阅读器，不能单独投稿。

## 0. 发布前先做（有时间门槛）

1. **GitHub 建公开仓库**（例如 `dsh-theme-studio`），把本仓库推上去。
2. 仓库 **Settings → Topics** 加 `dsh-plugin`（目录评审硬要求）。
3. **仓库必须创建满 1 天**才能通过目录 CI —— 所以先建仓，明天再提 PR。
4. 本仓库已包含：`assets/icon-180.png`（位图图标，**SVG 会被拒**）、`screenshots.json`（1–8 张截图）、`icon.png`、`LICENSE`、`README.md`、`CHANGELOG.md`。

把 `package.json`、`awesome-dsh-plugin-entry.example.yml` 里的 **`ruohan0713`** 全部替换成你的 GitHub 用户名（共 6 处，包括 `repository` / `homepage` / `bugs` / 示例条目 / icon raw 地址）。

## 1. GitHub（源码 + Releases）

在 GitHub 网页新建 **空** 仓库（Public，不勾 README），然后在本目录：

```bash
git remote add origin https://github.com/<你的GitHub用户名>/dsh-theme-studio.git
git branch -M main
git push -u origin main
git tag v1.3.4
git push origin v1.3.4
```

在 Release 页上传 `dsh-theme-studio-1.3.4.zip`，说明可直接用 `CHANGELOG.md` 的 1.3.4 段与 README 截图。

> 不想配 git 凭据：可用 GitHub 网页 **Add file → Upload files** 上传本目录内容，或用 GitHub Desktop。

## 2. npm（强烈建议，插件管理器一键安装依赖它）

npm 上 `dsh-theme-studio` 已被他人占用；本项目包名是 **`dsh-theme-studio-art`**（实测 404 可用）。
更推荐 scoped 名 **`@<你的npm用户名>/dsh-theme-studio`**（没有公共名冲突；scoped 包发布时要 `--access public`）。换名时同步改三处：`package.json.name`、`cordis.patch.yml` 的 `name`、README。

```powershell
# 本机 registry 指向 npmmirror（只读镜像，不能发布），发布时显式切官方源
npm config set registry https://registry.npmjs.org/
npm login                                  # 浏览器 OAuth / token + 2FA，需本人操作
npm whoami
npm publish --access public
npm view dsh-theme-studio-art version      # 确认已上架
```

要点：

- `repository` 必须**指回被收录的那个 GitHub 仓库**，否则目录不会把 npm 包与仓库关联。
- `private: true` 必须删掉（本仓库已删）。
- 如果声明 `engines.dsh`，范围必须带显式预发布分支，例如 `>=0.2.1-rc.2 <0.3.0-0`（`>=0.2.1-rc.2 <0.3.0` 会匹配不到预发布宿主）。
- 包体积约 24 MB（40 张壁纸）。首次安装会慢；可压缩壁纸到 2560×1440 / q82，或只保留 4–6 张示范图并在 README 说明可自备壁纸。

## 3. awesome-dsh-plugin 目录（DSH 社区索引 / dshmarket 数据源）

提交指南（以官方仓库为准）：
<https://cdn.jsdelivr.net/gh/awesome-dsh-plugin/awesome-dsh-plugin@main/contributing.md>

步骤：

1. Fork <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>。
2. 只新增一个文件：`data/plugins/<你的GitHub用户名>__<仓库名>.yml`，内容照抄本仓库的 `awesome-dsh-plugin-entry.example.yml`（把占位符换成你的信息）。
3. 开 PR。CI 会检查：
   - `package.json` 含 `dsh.bundle`（只声明 `dsh.client` 会失败）；
   - 仓库已满 1 天、有 `dsh-plugin` topic；
   - 描述与代码一致（评审会数主题数/核对 API，本仓库已校准 20 套）；
   - `icon` 必须是 GitHub 托管的位图（png/jpg/webp，约 96px 显示）；
   - 一个 PR 最多 3 条条目。
4. 合并后网站与 dshmarket 自动更新（通常 1 天内）。

条目示例（`description.en` 必填；含 `: ` 要加引号）：

```yaml
url: https://github.com/<user>/dsh-theme-studio
name: <user>/dsh-theme-studio
category: theme
description:
  en: "Twenty original literary themes for the DSH Web GUI: each ships light and dark palettes, 116 design tokens and an animated wallpaper."
  zh: "二十套原创文艺主题：每套含浅/深双调色板、116 个界面令牌与动态壁纸。"
icon: https://raw.githubusercontent.com/<user>/dsh-theme-studio/main/assets/icon-180.png
```

## 4. dshmarket

- 站点 <https://dshmarket.com>，仓库 <https://github.com/dsh-market/dsh-market>。
- **没有独立投稿口**：其 README 明确 "This repo is the market app, not the catalog … open a PR there [awesome-dsh-plugin]"。
- 目录合并后会自动出现在 dshmarket 的 **Themes** 标签页；插件分类必须写 `theme`。

## 5. 其他方式

- **Gitee 镜像**：可作国内下载源，但社区目录要求 `url` 必须是 `https://github.com/owner/repo`，且图标/截图须 GitHub 托管 → Gitee 只能当备用镜像，不能作为收录主仓库。
- **自建 format 1 索引**（让朋友"一步安装"）：把只含本插件的 `index.json` 放到公开仓库/静态托管，用户在 DSH「插件 → 发现 → 索引源」添加 URL。注意 DSH 对索引源：15 秒超时、**拒绝重定向**、单文件 ≤128 MiB。
- **GitHub Discussions / 社群**：发 Release 链接 + 截图即可；DSH 官方仓库接受 Discussions。

## 6. 发布后验证（干净 profile）

1. 设置 → 插件 → 搜索安装 `dsh-theme-studio-art`（或 scoped 名）；
2. 重启 DSH：20 套主题、主题按钮、三档清晰度、浅/深外观正常；
3. 设置 → 主题工作室 → 壁纸目录显示 40 张（20 主图 + 20 配套）。

> 本机当前以 `link:` 方式安装的是同名旧包 `dsh-theme-studio`；用正式包验证时先移除旧 link，避免同名冲突。
