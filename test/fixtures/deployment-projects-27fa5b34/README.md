# 旧发行部署项目模块兼容夹具

- 来源：本仓库 `27fa5b349e9b5e0e30c105f453ffca45216f45ad` 的 `src/deployment-projects.mjs`。
- 固定链接：[原始模块](https://github.com/coco-ari/CodeMinificationRepository/blob/27fa5b349e9b5e0e30c105f453ffca45216f45ad/src/deployment-projects.mjs)。
- SHA-256：`a462431a6b44997327aff46a94fea550b64a0345be6638c685c0d849f12c1ad3`。
- 保存方式：`git show` 的完整原始字节，未改注释、实现、空白或导入；它不是生产代码的另一份实现。

`test/deployment-projects.test.mjs` 先核对该摘要，再仅把 `./security.mjs` 导入重定向到当前真实公开安全模块，写入临时目录执行。测试让旧程序在新数据的隔离 SQLite 副本上运行初始化及 `ensureProject`，确认新增配置和原身份不丢失；不启动服务、不读取生产数据库。

夹具随测试提交，CI 浅克隆不再依赖旧 Git 对象或网络。禁止为通过测试修改夹具内容；如需新增另一个发行版本的兼容检查，应另存该版本的真实模块并记录提交与摘要。
