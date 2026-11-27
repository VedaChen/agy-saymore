# agy-saymore

让 [Antigravity CLI（`agy`）](https://antigravity.google) 执行任务的时候告知用户自己在干嘛，而不是默默干活不汇报。

## 效果

![agy-saymore 运行效果](assets/demo.png)

## 安装

需要 Node.js 18 及以上（hook 用 `node hooks/checklist.js` 执行）。

一条命令安装：

```bash
agy plugin install https://github.com/VedaChen/agy-saymore
```

安装后 `agy plugin list` 应显示 `progress-checklist (enabled)`，新会话立即生效。


## 许可

MIT
