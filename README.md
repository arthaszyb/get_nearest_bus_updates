# get_nearest_bus_updates

一键查询附近公交站到站时间的 iOS 快捷指令后端。

## 为什么需要这个

新加坡 LTA DataMall 的官方接口只支持"按已知站牌编号查询",不支持"按经纬度查附近站点"。
这个项目补上这一块:后端一次性拉取全岛约5000+个站点坐标,计算离你当前位置最近的几个站,
再查询这些站的实时到站时间,返回一段可以直接显示的纯文本。

配合 iOS 快捷指令(Shortcuts),可以做到真正的"一键直达":定位 → 查询 → 显示结果,
没有列表选择,没有确认弹窗。

## 架构

```
当前位置 (Shortcut 获取)
    │
    ▼
Cloudflare Worker (本仓库 worker/bus-nearest-worker.js)
    │  1. 并行拉取 LTA BusStops 全部分页
    │  2. 计算每个站点到当前位置的距离,取最近 N 个
    │  3. 查询这些站点的 LTA BusArrival(到站时间)
    │  4. 拼成纯文本返回
    ▼
iOS 快捷指令 "显示结果" / "快速查看"
```

## 部署

1. 注册 [LTA DataMall](https://datamall.lta.gov.sg) 账号,申请 API Account Key(免费,邮件发放)
2. 注册 [Cloudflare](https://dash.cloudflare.com) 免费账号
3. Workers & Pages → Create application → Start with Hello World! → 部署
4. 部署后点 Edit code,把 [`worker/bus-nearest-worker.js`](./worker/bus-nearest-worker.js) 的内容整个粘贴进去,覆盖默认代码,点 Deploy
5. 该 Worker 的 Settings → Variables and Secrets → 新增变量 `LTA_API_KEY`(类型选 Secret),值填第1步申请到的 Key
6. 复制 Worker 网址,形如 `https://xxx.yyy.workers.dev`

测试:浏览器访问 `https://xxx.yyy.workers.dev/?lat=1.3492&lon=103.7565`(换成你自己的坐标),
应返回附近几个站点的到站时间文本。

## iOS 快捷指令搭建

见 [`docs/ios-shortcut-setup.md`](./docs/ios-shortcut-setup.md)。

## 参数

`GET /?lat={纬度}&lon={经度}`

返回:纯文本,按距离由近到远列出附近站点,每个站点下列出各路线班次的预计到达时间(分钟)。

## 已知限制 / 后续可优化方向

- 每次请求都会重新拉取全量站点列表(约12次并行请求),没有做缓存,追求更快响应可以引入
  Cloudflare KV 定期缓存站点坐标(站点数据基本静态,不需要每次都拉)
- 目前按纯距离取最近 N 个站点(当前 N=4),没有做"对向站台"识别 —— LTA 站牌编号本身
  没有公开的、可靠的对向配对规律,纯距离是目前最稳妥的做法
