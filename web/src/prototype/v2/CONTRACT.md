# 交互原型 V2 共享接口（实现约定）

所有开发遵守仓库 AGENTS.md。业务基线见 examples/workbench-v2-requirements.md。新增模块位于本目录；不得修改其他代理负责文件。复用 shadcn/ui，统一 ui.jsx。

## Provider（root 负责 store.jsx）

`useWorkbench()` 返回：

- `state`, `user`, `project`, `projectId`, `route`（hash 去 # 的路径）, `navigate(path)`。
- `update(recipe)`：同步克隆当前 state，recipe(draft) 直接修改，不返回值。绝不从旧闭包整份覆盖 state。
- `updateProject(recipe, id=projectId)`：recipe(projectDraft,stateDraft)。
- `audit({projectId=null,action,object,result='成功'})`，全局机柜 projectId null。
- `notify({projectId=null,title,agentId=null})`。
- `startTask({projectId,type,title,artifactIds=[],agentId=null,duration=4500,outcome='success',logs=[],effects=[]})` 返回 taskId。任务由 provider 的持久化时钟推进，刷新/切页后恢复；效果在结束时原子应用。outcome 为 success/failed/rolledback/unknown；effects 只在 success 应用，failureEffects 在其他结果应用。
- `stopTask(id)`：标记 stopped，不执行 effects。
- `canUseAgent(agent,projectId)` 和 `canViewAgent(agentId,projectId)`：第一轮仅允许 `kind:'platform'`；私有仅 ownerId 可见，共享仅指定项目成员（管理员可管理项目，但不偷看私聊）。外部用户 Agent 后置，旧缓存保留记录但停止执行、隐藏相关会话和任务。
- 导出 `uid(prefix)`, `stamp()`（ISO）, `applyEffects(draft,effects)`；effect 格式 `{op:'append'|'patch'|'remove',path:['projects',projectId,'artifacts'],value:object,id?:itemId}`，数组 append 插到首位，patch 根据 id 浅合并，remove 根据 id。

全局 state：`schema:2,userId,users:[{id,name,username,password,role:'admin'|'member'}], projects:{[id]:Project},agents:[],conversations:[],cabinet:{},tasks:[],notifications:[],audit:[],connected:true`。
Project：`id,name,description,memberIds:[],environments:[{id,name,authBase}],resources:[{id,name,type:'Server'|'MySQL'|'Redis',environmentId:null,host,port,username,password,status:'untested'|'connected'|'failed',cpu:23,memory:48,disk:36}],services:[],documents:[],repositories:[],artifacts:[],rules:[]`。
Task：`id,projectId,type,title,status:'running'|'success'|'failed'|'rolledback'|'unknown'|'stopped',actorId,createdAt,progress,logs:[],artifactIds:[],agentId,effects,failureEffects,duration,elapsed`。私有任务/通知可见性按当前 Agent 设置实时计算。

## 模块导出 / 文件归属

- materials.jsx + material-seed.js（资料代理）：`MaterialsPage({tab})` tab documents/repositories/artifacts。`seedMaterials(projectId)` 返回 documents,repositories,artifacts,rules。artifacts 统一 `{id,name,type:'source'|'stripped'|'sanitized'|'zip'|'report'|'file',status:'ready',files:[{name,content}],content?,sourceId?,commit?,createdAt,deleted?:true}`。删除保留 tombstone。供共享 Agent 产物使用。
- agents.jsx + agent-seed.js（Agent 代理）：`AgentsPage()`, `ChatPage()`，`seedAgents()` 返回 `{agents,conversations}`。第一轮 Agent schema `{id,name,description,kind:'platform',ownerId,sharing:'private'|'project',projectId,status:'online'|'offline',...}`，管理员创建和配置。会话 `{id,projectId,agentId,environmentId:null, ...}`。私有聊天规则必须在模块内处理。
- cabinet.jsx + cabinet-seed.js（机柜代理）：`CabinetPage()`，`seedCabinet()` 返回 cabinet 对象；所有自动目标实时从 state.projects environments authBase 推导。全局操作不受项目成员身份限制。
- App.jsx + store.jsx + ui.jsx + operations.jsx + v2.css + 文档 + 测试（root）。

## 共享 UI（root 负责 ui.jsx）

导出 `Button,Input,Textarea,Label,Switch,Badge,Card,CardContent,CardHeader,CardTitle,Table,TableBody,TableCell,TableHead,TableHeader,TableRow,Progress`（原 shadcn 直接 re-export）；`Picker({value,onChange,options:[{value,label}],label,id})`；`PageHeader({title,children})`；`Panel({title,actions,children,className})`；`Field({label,children,hint})`；`Modal({title,open,onClose,children,footer,description})`；`Confirm({title,open,onClose,onConfirm,children,confirmLabel='确认',danger=false})`；`Status({value})`；`Empty({children})`；`CopyButton({value})`；`download(name,content,mime)`；`createZip(files)`；`downloadArtifact(artifact)`；`toast`。
公共 class：`wb-page` 页面纵列 gap24, `wb-grid` 响应式双栏, `wb-stack` 纵列gap16, `wb-row` 横向flex wrap gap12, `wb-muted`, `wb-code` 可滚动pre, `wb-table-actions`, `wb-empty`, `wb-danger`, `wb-form-grid` 双栏表单。不要自建表单控件。所有输入有 label/aria-label；Modal scroll max90dvh。

## 初始项目/用户

用户 admin（管理员 林知远）、lin（成员 林夏）、chen（成员 陈默），密码均 Demo123!（明确虚构演示）。项目 sol（SOL 设备平台，memberIds admin/lin）、atlas（Atlas 研发平台，memberIds admin/chen）。环境 sol-test / sol-prod；atlas-stage。服务 id sol-api/sol-web。初始源码 artifact id `source-sol` / `sanitized-sol`；由 seedMaterials 保证。
