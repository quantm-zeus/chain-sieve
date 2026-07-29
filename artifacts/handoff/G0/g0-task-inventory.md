# G0 task inventory

Cluster `C-G0-IMPLEMENTATION` contains exactly 14 `READY` tasks on canonical branch `cluster/g0`. Every task is in formal dependency wave 1.

| Task | State | Lock | Tests | Context SHA-256 | Goal SHA-256 |
| --- | --- | --- | ---: | --- | --- |
| `T-G0-COL-01` | `READY` | `apps/collector/public-api` | 8 | `562ff84a3393f34035991d60dbeed80874e68f40fee7a8a534380392e0fa79fa` | `2a3ed4a6e1dd08198a39883b0836e9001afa6b51b9cfa6a3ae18c2909eefd638` |
| `T-G0-COL-02` | `READY` | `apps/collector/public-api` | 6 | `aeaac7059ecdf3db2b0ba238f5968be2142f1b53f9b7c19e30d7151dd6ea9a00` | `56b7edfd73a1ad77fd67b8551aee73e0e592759e43e38d470125ac07794340cf` |
| `T-G0-CORE` | `READY` | `packages/domain/public-api` | 6 | `36357e4817107ddb2ca393ae730f56a71b376d1950a5357a421af5a8aae6ad29` | `5cb6753ef0c0962fcc0e9954d5d03d8003627072a617c16a4053e7c74a0fde85` |
| `T-G0-COST-01` | `READY` | `packages/cost-router/public-api` | 4 | `87eb69a295d370419e676b9b8c0826922b2ac6469b15d8e73b2552b887f2c638` | `865d390070b059300b3f1008d52792aaa42eb9f93ad82e73dd380f14136b2d5a` |
| `T-G0-COST-02` | `READY` | `packages/cost-router/public-api` | 4 | `58f7d644ab3da2a70c55beb29cfd2aac63fa30469ef67d1de5b81a760de6ef55` | `4f372245976a5d3568486b2775fe53a987f6d5235b99766d977e30fd6c9b2e37` |
| `T-G0-DATA` | `READY` | `infra/migrations` | 6 | `e0dbdd29166e54eb6c3d1be9bd024d240d728fc51b1a4bb489515c1bd937db2e` | `2cef4abf35e279dbf2fc11a4d9ab6ae3f913c709739fd5d523c08e5107c4b4f3` |
| `T-G0-DISC` | `READY` | `packages/discovery-universe/public-api` | 4 | `2585266019e65d2114f4cfe938dc909915bdb6d5f1fb5b01f1e3072c0d82d30a` | `9f5c7cd5665b712e6ce2d8408ee548f18e27e6425908edb91184b48372f46de4` |
| `T-G0-DR` | `READY` | `infra/migrations` | 6 | `d525aff792ce26b2735260a9648e190c8d4e89de3f89fe85ad3a230bdc634441` | `f20f698512efeceb7224f3ca3c3177881112f79e0bc72425cd24598d98aab045` |
| `T-G0-MCP` | `READY` | `apps/api/src/mcp/public-api` | 6 | `ccaa9d23323b161699e65e928e6903bcd8e020addb666047fc88a71064813524` | `73dadb10e989c5e1d868fcf344789bdf46b13e7de038872d35b3828c14d9a872` |
| `T-G0-PROV-01` | `READY` | `packages/provider-lifecycle/public-api` | 8 | `9e96da31fb7b7659c1a5b26aabee3fa7cf9637763b1930b3cf1d46b99e77f63b` | `7de8e120e3b299860b5adde3fb26c4d74f1f0a0cd02c33c95c1a31aae133883b` |
| `T-G0-PROV-02` | `READY` | `packages/provider-lifecycle/public-api` | 8 | `857667178f3f1dc3101db2bf78bf9c43c7eb241be2b784366bc608a315eb56a6` | `16f0da38214585f54567de8fc04e12f09c842c0c6974f4f2cd01e243d16ccdca` |
| `T-G0-SEC-01` | `READY` | `packages/security/public-api` | 6 | `cf56d8044afd090f15f6e7422095cd63443693feb3acc1d1e8941eda61b51224` | `9f48742ed2f3aa947c746aeac115f26ddf9af5a092fb61cb96dfd29208b4bea2` |
| `T-G0-SEC-02` | `READY` | `packages/security/public-api` | 6 | `c0d48c1d58dcc55e6682eec1e7efb9e1641352dd29737765f10b613d226c579c` | `7e7af7b0e22e779d9fa517a92b0f96433e1896acfc57850623ec2a47e1d0112d` |
| `T-G0-TRACE` | `READY` | `packages/requirement-manifest/public-api` | 10 | `51eb51b995044bc5892812edadbc5421fc679921c737b55d614ac85258374d7c` | `e5095faf8e8878de206591883df7e8e44feab40a72a104cdb5c8e6a441f6639f` |
