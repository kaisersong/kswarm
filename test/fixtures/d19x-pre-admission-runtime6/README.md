# 消费准入变更前的原 runtime6 源码

这是当前 fork 评审包427eaca2所处 unpublished runtime6 的原字节快照，不是已发布安装包/旧真实二进制。每文件SHA见manifest；测试加载仅重定位相对import，不重实现旧逻辑。后续增加durable admission语义时，必须改变尚未发布的runtime6 digest，旧连接/预编译SQL不得冒充新writer。storage5原快照另在d19x-original-storage5，不能拿本目录冒它。
