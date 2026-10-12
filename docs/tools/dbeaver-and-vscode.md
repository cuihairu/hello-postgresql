# DBeaver 与 VS Code 插件

数据库客户端有两类使用场景：管理与探索（看结构、改数据、画 ER 图）和编码中的随手查询（写业务时验证一条 SQL）。DBeaver 是前者的代表，VS Code 插件是后者的载体。这一页讲两者的连接配置与各自的坑。

## DBeaver 连接配置

新建连接（数据库 → 新建连接 → PostgreSQL）必填四项：Host、Port、Database、用户名/密码。连接前可以点"测试连接"，DBeaver 会提示下载 JDBC 驱动，按提示装即可。

连内网数据库通常不走公网直连，而是经跳板机 SSH 隧道。在连接设置的 SSH 标签页里启用：

```plaintext
勾选"使用 SSH 隧道"
  主机/IP:  bastion.example.com    -- 跳板机
  用户名:   cui                    -- 跳板机系统用户
  认证方式: 密钥（指定 ~/.ssh/id_ed25519）或密码
数据库连接本身的 Host 填跳板机视角的内网地址，如 10.0.0.8
```

流量路径是：DBeaver → SSH 到跳板机 → 跳板机连 10.0.0.8:5432。数据库侧看到的来源是跳板机 IP，[pg_hba](../security/pg-hba-and-authentication) 规则要覆盖它。写代码连库时的连接串与参数化用法见[客户端驱动](./client-drivers)。

## 元数据浏览与 ER 图

DBeaver 的数据库导航树按 库 → schema → 表/视图/索引/函数 分层展开，点开任意表能看到列、约束、DDL（DDL 标签页可直接复制建表语句）。顶部搜索框支持跨库模糊查对象名，接手陌生库时先搜表名和字段名。

ER 图：右键表 → View Diagram 看单表周边关系，右键 schema → View Diagram 看全库。它从外键约束推导关系——没有外键的库画出来是一堆孤岛，这也顺手检验了约束设计的完备性。

## SQL 编辑器与执行计划

DBeaver 的 SQL 编辑器除了写查询，还有几个值得知道的点：

- 表名、列名、关键字支持自动补全（`Ctrl+Space`），陌生库里写长 SQL 时能省不少翻结构的时间；
- 对 `EXPLAIN ANALYZE` 的结果可以切到执行计划图，与 pgAdmin 的计划可视化类似，条形图里一眼看出耗时大头；
- 常用脚本（DDL、批量清理语句）可以存成 SQL 模板（`Ctrl+Shift+T` 打开模板浏览器），选中执行，适合周期性维护动作。

## 数据编辑与提交模式

DBeaver 的数据网格可以直接编辑查询结果：双击单元格修改，`Ctrl+S` 保存时自动生成 `UPDATE` 语句。这里的坑在**事务模式**，工具栏默认 Auto-commit，但一旦切到 Manual Commit 模式：

- 保存后语句只是发出，**事务未提交**，其他会话看不到你的修改；
- 连接挂着未结束的事务，数据库里出现 `idle in transaction`，长时间不提交还可能阻塞 vacuum；
- 忘了在哪个模式？看工具栏的 commit 图标状态，或状态栏的 "Auto/Manual" 字样。

原则：编辑完数据立刻确认已提交；批量修改优先写显式 `UPDATE ... WHERE` 脚本而不是网格手点——网格编辑无法回溯改了哪些行，脚本可 review 可重放。另外结果集默认只抓前 200 行（fetch size），编辑超大数据集前先调大或加过滤条件。

## VS Code 插件：编码时不切窗口

VS Code 的 PostgreSQL 客户端插件（微软官方的 PostgreSQL 扩展 vscode-pgsql，或 Database Client 等同类）把"连库、执行查询"嵌进编辑器：侧边栏添加连接（同样的 host/port/user/password 四件套），写 SQL 的文件里选中语句执行，结果表格显示在下方面板。

它适合的循环是：改代码 → 顺手验证一条 SQL → 继续改代码。体验上的取舍：

- 查询结果面板比 DBeaver 简陋，复杂筛选、多结果集对比不方便；
- 没有数据网格编辑、ER 图这类管理功能；
- 连接配置跟随工作区（settings），提交仓库前检查别把密码写进去。

## 分工建议

| 场景 | 工具 |
| --- | --- |
| 写业务代码时随手查表、验证 SQL | VS Code 插件 |
| 看库结构、生成 DDL、画 ER 图 | DBeaver |
| 批量改数据、导出 CSV | DBeaver（或 psql `\copy`） |
| 值班看活动会话、备份恢复 | pgAdmin 4 或 psql |

工具只是界面，行为最终由数据库决定：事务怎么提交、权限够不够、超时多长，都遵循服务端规则。换工具排查问题时，先确认连接串和角色一致，再比较行为差异。

## 常见问题

- **SSL 设置**：DBeaver 连接属性里的 SSL Mode（disable/require/verify）与驱动参数同名同义；内网直连可用 disable，跨公网至少 require。
- **结果集被截断**：默认只抓前 200 行（smart fetch size）。要拿全量数据，把连接的 Rows count 设为 unlimited 或调大 fetch size；导出 CSV 用结果网格右键 Export Data，大导出仍建议直接跑 psql `\copy`。
- **"no active connection"**：连接被服务端主动断开——常见原因有 `idle_in_transaction_session_timeout` 把挂着的事务会话回收、网络中断后连接池没清理，检查一下连接串参数与数据库侧超时配置。
- **权限不足的报错**：先看连接列表里连的是哪个用户，不少情况是连到了默认用户而不是应用账户；角色与权限模型见[角色与权限](../security/roles-and-permissions)。

## 相关页面

- [pgAdmin 4](./pgadmin-4)
- [客户端驱动](./client-drivers)
- [psql 高阶](./psql-advanced)
- [pg_hba 与认证](../security/pg-hba-and-authentication)

官方文档：[DBeaver 官网](https://dbeaver.com/)、[VS Code PostgreSQL 扩展仓库](https://github.com/microsoft/vscode-pgsql)。
