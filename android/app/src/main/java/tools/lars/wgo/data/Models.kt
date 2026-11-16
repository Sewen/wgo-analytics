package tools.lars.wgo.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Mirrors of the widget API types in backend/src/contract.ts (WidgetMe, WidgetCatalog, WidgetSummary). */

val WgoJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

@Serializable
data class ProjectRef(val id: String, val name: String)

@Serializable
data class WidgetMe(val email: String, val projects: List<ProjectRef>)

@Serializable
data class StatOption(
    val key: String,
    val label: String,
    val description: String = "",
    val category: String = "",
)

@Serializable
data class WidgetCatalog(val options: List<StatOption>)

@Serializable
data class WidgetStat(
    val key: String,
    val label: String,
    val unit: String = "count", // count | ms | score | text
    val value: Double? = null,
    val previous: Double? = null,
    val better: String = "up", // up | down | none
    val rating: String? = null, // good | warn | bad
    val text: String? = null,
    val suffix: String? = null,
    val series: List<Double> = emptyList(),
    val page: String = "overview",
)

@Serializable
data class WidgetSummary(
    val project: ProjectRef,
    val range: String,
    val from: String,
    val to: String,
    val generatedAt: String,
    val stats: List<WidgetStat>,
)

val RANGES = listOf("1h", "24h", "7d", "30d")

/** Built-in stats offered before the catalog has loaded, and the default selection for new widgets. */
val DEFAULT_STATS = listOf("visitors_now", "pageviews", "sessions", "errors")
const val MAX_STATS = 8
