package tools.lars.wgo.data

import android.content.Context
import android.net.Uri
import androidx.core.content.edit

/**
 * The paired WGO account: API base URL, dashboard URL (for tap-through) and a read-only device token.
 * Stored in app-private SharedPreferences, excluded from backups (see res/xml/backup_rules.xml).
 */
data class Account(
    val apiUrl: String,
    val dashUrl: String,
    val token: String,
    val email: String,
) {
    val host: String get() = Uri.parse(dashUrl.ifBlank { apiUrl }).host ?: apiUrl
}

/** What a connection link carries before it has been verified against the API. */
data class Pairing(val apiUrl: String, val dashUrl: String, val token: String)

object AccountStore {
    private const val PREFS = "wgo.account"

    fun get(context: Context): Account? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val api = p.getString("api", null) ?: return null
        val token = p.getString("token", null) ?: return null
        return Account(api, p.getString("dash", "") ?: "", token, p.getString("email", "") ?: "")
    }

    fun save(context: Context, a: Account) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
        putString("api", a.apiUrl)
        putString("dash", a.dashUrl)
        putString("token", a.token)
        putString("email", a.email)
    }

    fun clear(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { clear() }

    /**
     * Accepts any of the forms the dashboard hands out:
     *   wgo://pair?api=…&dash=…&token=dt_…
     *   https://<dashboard>/pair.html#api=…&dash=…&token=dt_…
     * or that text pasted with surrounding whitespace.
     */
    fun parsePairing(raw: String?): Pairing? {
        val text = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val uri = runCatching { Uri.parse(text) }.getOrNull() ?: return null
        val params = buildMap {
            fun addAll(s: String?) = s?.split('&')?.forEach { kv ->
                val i = kv.indexOf('=')
                if (i > 0) put(kv.substring(0, i), Uri.decode(kv.substring(i + 1)))
            }
            addAll(uri.encodedQuery)
            addAll(uri.encodedFragment)
        }
        val token = params["token"]?.takeIf { Regex("^dt_[A-Za-z0-9]{20,80}$").matches(it) } ?: return null
        val api = params["api"]?.trimEnd('/')?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: return null
        val dash = params["dash"]?.trimEnd('/')
            ?: if (uri.scheme == "https" || uri.scheme == "http") "${uri.scheme}://${uri.authority}" else ""
        return Pairing(api, dash, token)
    }
}

/** App-wide settings. */
object Settings {
    private const val PREFS = "wgo.settings"
    val INTERVALS = listOf(15, 30, 60, 180)

    fun refreshMinutes(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("refreshMinutes", 30)

    fun setRefreshMinutes(context: Context, minutes: Int) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putInt("refreshMinutes", minutes) }
}
