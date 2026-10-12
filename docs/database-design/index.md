# 第2部分：数据库设计

从范式理论到物理落地的完整设计路径：主键与外键、约束与数据质量、分区与多租户，以及常见反模式清单。

- [三范式与反范式](normalization-and-denormalization.md) —— 1NF/2NF/3NF 推导、冗余与读性能的权衡。
- [主键设计](primary-key-design.md) —— BIGINT identity vs UUID vs 复合键，对索引与游标分页的影响。
- [外键与引用动作](foreign-keys-and-referential-actions.md) —— ON DELETE CASCADE/SET NULL、延迟约束。
- [CHECK 与域类型](check-and-domains.md) —— 域复用、正则约束、约束命名规范。
- [表继承与分区表设计](table-inheritance-and-partitioning-design.md) —— 声明式 PARTITION BY RANGE/LIST/HASH。
- [视图与可更新视图](views-and-updatable-views.md) —— 简单视图可写性、WITH CHECK OPTION。
- [物化视图](materialized-views.md) —— REFRESH CONCURRENTLY、增量刷新思路与使用场景。
- [逻辑建模到物理落地](logical-to-physical-modeling.md) —— E-R 图到 DDL：序列、默认值、时间戳惯例。
- [软删除与墓碑](soft-delete-and-tombstone.md) —— deleted_at、唯一索引与 NULL、部分索引配合。
- [多租户建模](multi-tenant-modeling.md) —— schema-per-tenant vs RLS vs 单表 tenant_id。
- [时间建模](time-modeling.md) —— timestamptz 惯例、时区处理、有效期用 range 类型。
- [金额与数值](money-and-numeric.md) —— numeric 定点、货币字段、舍入规则。
- [约束与数据质量](constraints-and-data-quality.md) —— NOT NULL 策略、EXCLUSION 约束、触发器兜底。
- [反模式清单](anti-patterns.md) —— EAV 滥用、万能 JSONB 表、无界自关联。

---

- [基础知识](../basics/) · [索引体系](../indexing/) —— 设计落地后的索引配套。
