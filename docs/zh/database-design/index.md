# 数据库设计

范式、主键与外键、约束与数据质量、分区和多租户设计，以及常见反模式：主键与外键、约束与数据质量、分区与多租户，以及常见反模式清单。

- [三范式与反范式](/zh/database-design/normalization-and-denormalization) —— 1NF/2NF/3NF 推导、冗余与读性能的权衡。
- [主键设计](/zh/database-design/primary-key-design) —— BIGINT identity vs UUID vs 复合键，对索引与游标分页的影响。
- [外键与引用动作](/zh/database-design/foreign-keys-and-referential-actions) —— ON DELETE CASCADE/SET NULL、延迟约束。
- [CHECK 与域类型](/zh/database-design/check-and-domains) —— 域复用、正则约束、约束命名规范。
- [表继承与分区表设计](/zh/database-design/table-inheritance-and-partitioning-design) —— 声明式 PARTITION BY RANGE/LIST/HASH。
- [视图与可更新视图](/zh/database-design/views-and-updatable-views) —— 简单视图可写性、WITH CHECK OPTION。
- [物化视图](/zh/database-design/materialized-views) —— REFRESH CONCURRENTLY、增量刷新思路与使用场景。
- [逻辑建模到物理落地](/zh/database-design/logical-to-physical-modeling) —— E-R 图到 DDL：序列、默认值、时间戳惯例。
- [软删除与墓碑](/zh/database-design/soft-delete-and-tombstone) —— deleted_at、唯一索引与 NULL、部分索引配合。
- [多租户建模](/zh/database-design/multi-tenant-modeling) —— schema-per-tenant vs RLS vs 单表 tenant_id。
- [时间建模](/zh/database-design/time-modeling) —— timestamptz 惯例、时区处理、有效期用 range 类型。
- [金额与数值](/zh/database-design/money-and-numeric) —— numeric 定点、货币字段、舍入规则。
- [约束与数据质量](/zh/database-design/constraints-and-data-quality) —— NOT NULL 策略、EXCLUSION 约束、触发器兜底。
- [反模式清单](/zh/database-design/anti-patterns) —— EAV 滥用、万能 JSONB 表、无界自关联。

---

- [基础知识](/zh/basics/index) · [索引体系](/zh/indexing/index) —— 设计落地后的索引配套。
