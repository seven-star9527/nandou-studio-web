using System.IO;
using System.Net.Http;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;

namespace SwarmUI.WebAPI;

public static partial class StudioCloudAPI
{
    // Public default-group quotes; these are neither account-specific prices nor
    // a hard total-cost ceiling. Task receipts retain provider-native credits.
    private const decimal ReferenceCreditsPerUsd = 10m;
    private static readonly ConcurrentDictionary<string, (JObject Data, DateTime Captured)> Prices = new();
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> PriceLocks = new();

    private static decimal? NonnegativeNumber(JToken value)
    {
        if (value?.Type is not (JTokenType.Integer or JTokenType.Float)) return null;
        try { decimal number = value.Value<decimal>(); return number >= 0 ? number : null; }
        catch { return null; }
    }
    private static bool Succeeded(JObject value) => value?["success"]?.Type == JTokenType.Boolean && value.Value<bool>("success");

    /// <summary>Whitelist numeric balance fields, never return raw account data.</summary>
    public static JObject NormalizeAccount(JObject account, JObject token, string checkedUtc)
    {
        decimal? accountCredits = Succeeded(account) ? NonnegativeNumber(account["remain_credits"]) : null;
        bool unlimited = Succeeded(token) && token["unlimited_quota"]?.Type == JTokenType.Boolean && token.Value<bool>("unlimited_quota");
        decimal? tokenCredits = Succeeded(token) && !unlimited ? NonnegativeNumber(token["remain_credits"]) : null;
        bool tokenReady = Succeeded(token) && (unlimited || tokenCredits.HasValue);
        decimal? available = accountCredits.HasValue && tokenReady ? unlimited ? accountCredits : Math.Min(accountCredits.Value, tokenCredits.Value) : null;
        JObject result = new()
        {
            ["configured"] = true,
            ["state"] = available.HasValue ? "ready" : accountCredits.HasValue || tokenReady ? "partial" : "unavailable",
            ["remaining_credits"] = available, ["account_credits"] = accountCredits,
            ["token_credits"] = tokenCredits, ["token_unlimited"] = unlimited,
            ["account_state"] = accountCredits.HasValue ? "ready" : "unavailable",
            ["token_state"] = tokenReady ? "ready" : "unavailable", ["checked_utc"] = checkedUtc
        };
        if (!available.HasValue) result["error"] = "可用积分暂未确认；账户余额与密钥额度均需查询成功";
        return result;
    }

    public static async Task<JObject> GetStudioCloudAccount(Session session)
    {
        string key = Key();
        if (key.Length == 0) return new JObject { ["configured"] = false, ["state"] = "not_configured", ["remaining_credits"] = null, ["account_credits"] = null, ["token_credits"] = null, ["token_unlimited"] = false, ["checked_utc"] = DateTime.UtcNow.ToString("o") };
        async Task<JObject> Balance(string suffix)
        {
            try
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.apimart.ai/v1/" + suffix);
                return await Call(request, key, deadline.Token);
            }
            catch { return null; } // No provider body, account identity or key in errors/logs.
        }
        Task<JObject> account = Balance("user/balance"), token = Balance("balance");
        await Task.WhenAll(account, token);
        return NormalizeAccount(account.Result, token.Result, DateTime.UtcNow.ToString("o"));
    }

    /// <summary>Compute only the documented output/precharge component.</summary>
    public static JObject CalculateQuote(JObject input, JObject response, string capturedUtc, bool stale)
    {
        string model = (string)input["model"], resolution = ((string)input["resolution"] ?? "1K").ToUpperInvariant();
        string size = (string)input["size"] ?? "auto", quality = (string)input["quality"] ?? "auto";
        int count = input.Value<int?>("n") ?? 1;
        JObject quote = new()
        {
            ["model"] = model, ["kind"] = "unknown", ["credits_per_image"] = null,
            ["min_credits_per_image"] = null, ["max_credits_per_image"] = null,
            ["credits_total_reference"] = null, ["label"] = "预计积分待定，按实际用量结算",
            ["source"] = "https://api.apimart.ai/api/pricing/model?model=" + Uri.EscapeDataString(model),
            ["captured_at"] = capturedUtc, ["stale"] = stale,
            ["scope"] = "public_default_group", ["account_specific_price_unknown"] = true,
            ["additional_input_cost_unknown"] = true, ["credits_per_usd_reference"] = ReferenceCreditsPerUsd
        };
        if (!Succeeded(response) || response["data"] is not JObject data) return quote;
        JObject pricing = data["pricing"] as JObject;
        if ((string)pricing?["unit"] != "usd_per_million_tokens") return quote;
        if (model == "gemini-nano-banana-2.1")
        {
            if ((string)data["precharge_billing_type"] != "resolution_fixed") return quote;
            decimal? dollars = NonnegativeNumber(data["resolution_paid_prices"]?[resolution]);
            if (!dollars.HasValue) return quote;
            decimal credits = dollars.Value * ReferenceCreditsPerUsd;
            quote["kind"] = "precharge_reference"; quote["credits_per_image"] = credits;
            quote["credits_total_reference"] = credits * count;
            quote["label"] = "预计预留积分参考；最终按实际 token 结算，公开默认分组价可能与账户不同";
            return quote;
        }
        if (model is not ("gpt-image-2.5-flare" or "gpt-image-2.5-sunburst") || size == "auto" || size.Contains('x')) return quote;
        string sizeKey = resolution switch { "1K" => size, "2K" => size + "@2k", "4K" => size + "@4k", _ => "" };
        JObject tokens = data["size_quality_tokens"]?[sizeKey] as JObject;
        decimal? rate = NonnegativeNumber(pricing?["effective_rates"]?["image_output"]);
        if (tokens is null || !rate.HasValue) return quote;
        decimal? Cost(string level) => NonnegativeNumber(tokens[level]) is decimal amount ? amount * rate.Value / 1_000_000m * ReferenceCreditsPerUsd : null;
        if (quality == "auto")
        {
            decimal? low = Cost("low"), high = Cost("max");
            if (!low.HasValue || !high.HasValue || high < low) return quote;
            quote["kind"] = "output_reference"; quote["min_credits_per_image"] = low; quote["max_credits_per_image"] = high;
            // Keep a range; the maximum is not a guaranteed total-cost ceiling.
            quote["label"] = "自动质量的单张输出积分参考范围；另计输入用量，实际账户分组价可能不同";
        }
        else if (Cost(quality) is decimal credits)
        {
            quote["kind"] = "output_reference"; quote["credits_per_image"] = credits;
            quote["credits_total_reference"] = credits * count;
            quote["label"] = "单张输出积分参考；另计提示词和参考图输入用量，实际账户分组价可能不同";
        }
        return quote;
    }

    public static async Task<JObject> GetStudioCloudQuote(Session session, JObject rawInput)
    {
        JObject input = (JObject)rawInput.DeepClone();
        input["prompt"] = "报价"; input["operation"] = "generate"; input["reference_images"] = new JArray();
        if (input["n"] is null) input["n"] = 1;
        try { ValidateRequest(input, Capabilities); }
        catch (Exception e) when (e is ArgumentException or FormatException) { return Error(e.Message); }
        string model = (string)input["model"];
        var gate = PriceLocks.GetOrAdd(model, _ => new(1, 1));
        await gate.WaitAsync();
        try
        {
            bool stale = false;
            bool cached = Prices.TryGetValue(model, out var price);
            if (!cached || DateTime.UtcNow - price.Captured > TimeSpan.FromMinutes(5))
            {
                try
                {
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                    using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.apimart.ai/api/pricing/model?model=" + Uri.EscapeDataString(model));
                    using var response = await Client.SendAsync(request, deadline.Token); // Anonymous, never attach API key.
                    response.EnsureSuccessStatusCode();
                    string text = await response.Content.ReadAsStringAsync(deadline.Token);
                    if (text.Length > 2_000_000) throw new InvalidDataException("Pricing response too large");
                    JObject body = JObject.Parse(text);
                    if (!Succeeded(body) || body["data"] is not JObject) throw new InvalidDataException("Unknown pricing response");
                    price = (body, DateTime.UtcNow); Prices[model] = price;
                }
                catch { stale = cached; }
            }
            return CalculateQuote(input, price.Data, cached || price.Data is not null ? price.Captured.ToString("o") : null, stale);
        }
        finally { gate.Release(); }
    }
}
