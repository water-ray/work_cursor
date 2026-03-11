# Frontend Country Metadata

## 位置

- 前端通用国家表：`TauriApp/src/renderer/src/app/data/countryMetadata.ts`

## 作用

- 统一维护国家/地区元数据，避免不同页面各自写一份映射。
- 统一国家展示样式：优先使用字体国旗 emoji，不依赖远程图片资源。
- 统一国家搜索规则：支持国家缩写、英文名、中文名、常见别名的包含匹配。

## 字段

每条国家记录包含以下字段：

- `code`: 两位国家/地区缩写，例如 `US`、`JP`、`HK`
- `englishName`: 英文名称，例如 `United States`
- `chineseName`: 中文名称，例如 `美国`
- `flagEmoji`: 字体国旗 emoji，例如 `🇺🇸`
- `searchText`: 预计算搜索文本，供前端下拉/筛选直接复用

## 已提供能力

- `countryMetadataList`
  - 完整国家/地区列表，可直接用于构建下拉选项。
- `resolveCountryMetadata(value)`
  - 输入国家缩写、中文、英文或常见别名，返回统一国家元数据。
- `normalizeCountryCode(value)`
  - 统一规范化为两位国家缩写。
- `resolveCountryFlagEmoji(value)`
  - 返回字体国旗 emoji。
- `buildCountrySearchText(value)`
  - 构建标准化搜索文本，用于前端 `Select` / 过滤器。

## 搜索规则

支持以下输入方式：

- 国家缩写：如 `US`、`JP`、`HK`
- 中文名称：如 `美国`、`日本`、`香港`
- 英文名称：如 `United States`、`Japan`、`Hong Kong`
- 常见别名：如 `UK`、`USA`、`Macao`

推荐使用“包含匹配”而不是“前缀匹配”，例如：

- 输入 `U` 时，应匹配所有缩写/中文/英文中包含 `U` 的国家
- 输入 `港` 时，应匹配 `香港`
- 输入 `kong` 时，应匹配 `Hong Kong`

## 当前使用位置

- `ProxyPage` 启动管理中的“智能优选”下拉
- `SubscriptionsPage` 节点表中的国家 emoji 展示

## 推荐用法

```ts
import {
  buildCountrySearchText,
  resolveCountryMetadata,
} from "../../app/data/countryMetadata";

const options = countries.map((code) => {
  const meta = resolveCountryMetadata(code);
  return {
    value: code,
    label: `${meta?.flagEmoji ?? ""} ${meta?.chineseName ?? code}`,
    searchText: buildCountrySearchText(code),
  };
});

const filterOption = (input: string, option?: { searchText?: string }) => {
  const keyword = buildCountrySearchText(input);
  if (keyword === "") {
    return true;
  }
  return String(option?.searchText ?? "").includes(keyword);
};
```

## 约束

- 新增国家展示或国家筛选功能时，优先复用这份通用国家表。
- 不再新增单页私有国家映射、远程国旗图片地址拼接、重复别名表。
- 若需补充别名，只在 `countryMetadata.ts` 中统一维护。
# Country Metadata

## 目的

前端统一使用 `TauriApp/src/renderer/src/app/data/countryMetadata.ts` 作为国家/地区元数据来源，避免各页面重复维护：

- 国家缩写
- 英文全名
- 中文名称
- 字体国旗 emoji
- 搜索匹配文本

## 数据字段

`CountryMetadata` 结构：

- `code`: ISO 3166-1 alpha-2 国家/地区缩写
- `englishName`: 英文名称
- `chineseName`: 中文名称
- `flagEmoji`: 由国家缩写转换出的字体国旗 emoji
- `searchText`: 已归一化的搜索文本，供前端 `Select` / 筛选框做包含匹配

## 当前导出

- `COUNTRY_REGION_CODES`
  - 完整国家/地区缩写表
- `countryMetadataList`
  - 完整国家元数据表
- `countryMetadataByCode`
  - 通过缩写快速索引国家元数据
- `normalizeCountryCode(value)`
  - 归一化国家输入，支持 `UK -> GB` 等别名
- `resolveCountryMetadata(value)`
  - 从缩写、英文名、中文名、别名中解析国家元数据
- `resolveCountryFlagEmoji(value)`
  - 获取字体国旗 emoji
- `buildCountrySearchText(value)`
  - 构造统一搜索文本

## 搜索约定

所有国家选择器、国家筛选框、智能优选下拉，统一按“包含匹配”搜索下列信息：

- 国家缩写
- 英文全名
- 中文名称
- 文本别名

例如输入：

- `U`
  - 可命中 `US` / `UG` / `UA` / `UY`
- `United`
  - 可命中 `United States` / `United Kingdom`
- `美`
  - 可命中 `美国`
- `香港`
  - 可命中 `HK`

## UI 规范

- 国旗统一使用 `flagEmoji`，不要再单独接图片 CDN。
- 下拉项推荐展示：
  - 第一行：`emoji + 中文名`
  - 第二行：`国家缩写 + 英文名`
- 已选中值可以压缩显示为：
  - `emoji + 中文名`

## 使用示例

```ts
import {
  buildCountrySearchText,
  resolveCountryFlagEmoji,
  resolveCountryMetadata,
} from "../../app/data/countryMetadata";

const metadata = resolveCountryMetadata("US");
const flag = resolveCountryFlagEmoji("US");
const searchText = buildCountrySearchText("United States");
```

## 说明

- 当前表已经包含完整前端国家元数据，可直接复用。
- 若后续新增国家别名或自定义地区映射，优先补充到 `COUNTRY_TEXT_ALIASES`，不要在业务页面内写分散兼容逻辑。
# Wateray Country Metadata

## 目标

- 前端统一使用一份国家/地区元数据表。
- 统一提供国家缩写、英文名、中文名、字体国旗表情、搜索文本。
- 避免各页面重复维护国家映射、国旗资源和搜索逻辑。

## 代码位置

- 共享模块：`TauriApp/src/renderer/src/app/data/countryMetadata.ts`

## 导出内容

| 导出名 | 说明 |
| --- | --- |
| `COUNTRY_REGION_CODES` | 标准国家/地区 alpha-2 代码表，作为单一数据源 |
| `countryMetadataList` | 完整国家/地区元数据表 |
| `countryMetadataByCode` | 以代码为 key 的快速查询表 |
| `normalizeCountryCode()` | 将国家缩写/英文名/中文名归一化为标准代码 |
| `resolveCountryMetadata()` | 根据任意国家输入拿到完整元数据 |
| `resolveCountryFlagEmoji()` | 获取字体国旗表情 |
| `buildCountrySearchText()` | 生成统一搜索文本 |

## 数据结构

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | `string` | 国家/地区 alpha-2 缩写，例如 `US` |
| `englishName` | `string` | 英文名称，例如 `United States` |
| `chineseName` | `string` | 中文名称，例如 `美国` |
| `flagEmoji` | `string` | 字体国旗表情，例如 `🇺🇸` |
| `searchText` | `string` | 用于包含检索的归一化搜索文本 |

## 搜索规则

- 搜索时同时匹配：
  - 国家缩写，例如 `US`
  - 英文名称，例如 `United States`
  - 中文名称，例如 `美国`
- 搜索使用包含匹配，不要求前缀一致。
- 搜索会做归一化：
  - 忽略大小写
  - 压缩多余空格
  - 去掉常见标点
  - 处理英文重音字符，便于模糊检索

## UI 约定

- 国旗统一使用字体表情，不再依赖外部图片链接。
- 下拉框选中态优先显示：`国旗 + 中文名`
- 下拉菜单可补充显示：`缩写 + 英文名`
- 无法识别的国家值允许保留原始文本，但不显示国旗表情。

## 常用示例

| 缩写 | 英文名 | 中文名 | 国旗 |
| --- | --- | --- | --- |
| `US` | United States | 美国 | `🇺🇸` |
| `GB` | United Kingdom | 英国 | `🇬🇧` |
| `JP` | Japan | 日本 | `🇯🇵` |
| `SG` | Singapore | 新加坡 | `🇸🇬` |
| `HK` | Hong Kong | 香港 | `🇭🇰` |
| `TW` | Taiwan | 台湾 | `🇹🇼` |
| `MO` | Macao | 澳门 | `🇲🇴` |

## 使用示例

```ts
import {
  buildCountrySearchText,
  normalizeCountryCode,
  resolveCountryMetadata,
} from "../../app/data/countryMetadata";

const metadata = resolveCountryMetadata("United States");
// => { code: "US", englishName: "United States", chineseName: "美国", flagEmoji: "🇺🇸", ... }

const code = normalizeCountryCode("香港");
// => "HK"

const searchText = buildCountrySearchText("US United States 美国");
// => 统一归一化后的搜索文本
```

## 维护说明

- 后续新增页面需要国家显示、国家搜索、国家筛选时，直接复用该模块。
- 若发现个别国家中文/英文名称需要更贴近产品展示，可在模块中的覆盖表追加修正。
- 完整标准代码列表以 `COUNTRY_REGION_CODES` 为准，不在各页面重复定义。
