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
6. 再新增一个变量 `ACCESS_TOKEN`(类型选 Secret),值随便设一串你自己记得住的暗号(例如一串随机字符),
   用来防止别人拿到网址后白嫖调用你的接口
7. (可选,推荐)设置本地缓存,避免每次请求都重新拉取全量约5000个站点坐标:
   - Workers & Pages 左侧菜单 → **KV** → Create a namespace,起个名字比如 `bus-stops-cache`
   - 回到你的 Worker → Settings → Bindings → Add binding → 选 **KV Namespace**,
     Variable name 填 `BUS_STOPS_KV`,选刚才创建的命名空间,保存
   - 站点坐标数据基本不变,缓存 7 天自动过期刷新;如果想手动强制刷新,访问时加 `&refresh=1` 参数即可跳过缓存
8. 复制 Worker 网址,形如 `https://xxx.yyy.workers.dev`

测试:浏览器访问 `https://xxx.yyy.workers.dev/?lat=1.3492&lon=103.7565&token=你设的暗号`(换成你自己的坐标和暗号),
应返回附近几个站点的到站时间文本。没有 `token` 参数或暗号不对会返回 401。

## iOS 快捷指令搭建

见 [`docs/ios-shortcut-setup.md`](./docs/ios-shortcut-setup.md)。

## 参数

`GET /?lat={纬度}&lon={经度}&token={你设置的 ACCESS_TOKEN}`

返回:纯文本,按距离由近到远列出附近站点,每个站点下列出各路线班次的预计到达时间(分钟)。
`token` 不匹配时返回 401。

## 已知限制 / 后续可优化方向

- 目前按纯距离取最近 N 个站点(当前 N=4),没有做"对向站台"识别 —— LTA 站牌编号本身
  没有公开的、可靠的对向配对规律,纯距离是目前最稳妥的做法
