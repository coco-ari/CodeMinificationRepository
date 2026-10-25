# Maven 多模块部署夹具

父工程包含 `common` 和 `app`。`app` 显式依赖 `common`，健康接口实际调用公共模块方法，用于验证部署引擎从仓库根执行 `mvn -pl app -am clean package` 的模块选择与依赖构建顺序。

沿用单模块示例中的 Compiler 3.13.0、Jar 3.4.2。Maven 既有资源阶段将本工程 `common/target/classes` 中的公共类放入应用 JAR；未增加 Shade、Spring Boot 或第三方业务依赖。此打包方式仅用于受控验收夹具，不作为任意第三方依赖的通用打包器。

工作区部署源码根选择本目录，构建目录和服务模块选择 `app`，产物路径为 `app/target/demo.jar`。只发布应用 JAR 即可运行，无须复制公共 JAR：

```sh
mvn -B -ntp -pl app -am clean package
java -jar app/target/demo.jar --port=18081
```

`GET /health` 正常返回 `200 cmr-demo-ready`。传入 `--unhealthy` 后返回 `503 unhealthy`，用于真实发布失败与自动恢复验收。夹具不连接数据库或其他业务服务。
