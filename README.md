# Folia 专辑播放（album-play）

给 [Folia](https://github.com/chthollyphile/folia-major) 的 Folium 模组：在宿主只有「歌曲级随机 + off/all/one 循环」的基础上，补上**专辑级**的播放方式。

宿主自带的随机（`src/components/app/playback/shuffle/shuffleRound.ts`）按歌曲洗牌，循环只有关闭 / 列表 / 单曲，没有「整张专辑当一个单位」的概念。这个模组用 Folium 的公开接口（`replaceQueue` / `getQueue` / `playQueueItem` / `setLoopMode`）实现：

| 功能 | 说明 |
| --- | --- |
| 专辑随机 | 队列按「来源 + 专辑名」分组，整张专辑作为一个单位洗牌，组内顺序不变 |
| 专辑循环 | 队列临时换成当前专辑并设为列表循环，放完最后一首回到第一首 |
| 下一张 / 上一张专辑 | 按队列顺序跳到相邻专辑的第一首，首尾回绕 |
| 撤销上一次 | 记住上一次整表替换之前的队列与循环模式，随时还原；在专辑循环里就是退出循环 |

支持 zh-CN / zh-TW / en 文案，设置项与播放器面板都跟随宿主主题（`--folium-*` CSS 变量）。

## 安装

1. 从 [Releases](../../releases) 下载 `album-play-x.y.z.zip`（或自己打包，见下）。
2. Folia → 设置 → 模组：打开总开关，把 zip 拖进模组面板（或解压到用户模组目录）。
3. 在弹出的确认里启用 `album-play`；它申请的权限只有 `playback.control` 和 `playback.queue`。

需要 Folium 1.7 及以上（`replaceQueue` 从 1.7 开始提供），宿主版本不够时模组会直接提示并退出。

## 入口

- **命令面板**（Ctrl/Cmd + K）：`专辑随机播放`、`循环这张专辑`、`下一张专辑`、`上一张专辑`、`撤销上一次专辑操作`
- **播放器面板 →「专辑」标签页**：当前专辑、专辑循环状态，以及对应的按钮
- **设置 → 模组 → 本模组**：`保留当前专辑在最前`、`随机后设为列表循环`

## 已知限制

- **专辑内顺序只能沿用队列原顺序**：`FoliumSong` 只有 `album` 字符串，没有碟号、曲序号，模组无法把乱序的同专辑歌曲重新排对。
- **整表替换会结束个人 FM**（`replaceQueue` 的既定语义），正在播放的歌不会被打断；专辑循环期间队列就是那张专辑。
- **和宿主自带随机互斥**：宿主按钮仍是歌曲级、按轮不重复，模组不会改写它的行为。
- 队列上限 5000 首（`replaceQueue` 与共享 ref 池的上限）。
- 专辑循环状态只存在内存里，模组重载后请用宿主提示条上的撤销或重新排队列。
- 成功提示与宿主的「某模组替换了队列 · 撤销」共用同一个提示通道（`useStatusMessageStore`），后写的覆盖前面的；模组自己提供撤销，所以这是有意取舍。

## 开发

```bash
# 逻辑测试：mock 掉 folium 接口，只测命令与队列操作
node test/mock.test.mjs

# 语法检查
node --check album-play/client.mjs
```

目录：

```
album-play/          模组本体（mod.json + client.mjs + README.md）
test/mock.test.mjs   25 项断言：分组、置顶、洗牌、循环进出、撤销、切专辑、各种拒绝/重试路径
```

打包 zip 时注意条目路径用正斜杠：宿主会拒绝带反斜杠或绝对路径的条目（`Compress-Archive` 在 Windows 上会写出反斜杠，不能用）。

## 许可

[MIT](LICENSE) © 2026 45steel
