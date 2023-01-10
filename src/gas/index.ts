export const MAX_EXPIRATION = 60 * 60 * 6;
const {
  BOT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  GPT_KEY,
  code_verifier,
  PROMPT
} = PropertiesService.getScriptProperties().getProperties();

global.tick = function() {
  let lastMentionId = CacheService.getScriptCache().get("lastMentionId") as string;

  const service = getService();
  if (!service.hasAccess()) {
    if (lastMentionId) {
      CacheService.getScriptCache().put("lastMentionId", lastMentionId, MAX_EXPIRATION);
    }
    const authorizationUrl = service.getAuthorizationUrl();
    throw new Error(`Authorization failed. Open the following URL and re-run the script: ${authorizationUrl}`);
  }

  let url = `https://api.twitter.com/2/users/${BOT_ID}/mentions?max_results=5&expansions=referenced_tweets.id`;
  if (lastMentionId) {
    url += `&since_id=${lastMentionId}`;
  }
  const response = UrlFetchApp.fetch(url,
    {
      headers: {
        "User-Agent": "v2UserMentionssJS",
        authorization: `Bearer ${service.getAccessToken()}`
      }
    });

  const mentions = JSON.parse(response.getContentText());
  console.log(mentions);

  mentions?.data?.forEach((m: any) => {
    console.log(m.referenced_tweets);
    // do not debunk if already debunked
    const alreadyDebunked = m.referenced_tweets?.find((ref: any) => ref.text?.toLowerCase().includes("@pleasedebunk"));
    if (alreadyDebunked) return;

    const refTweet = m.referenced_tweets?.find((ref: any) => ref.type === "replied_to");
    const refTweetText: string = mentions.includes?.tweets?.find((tweet: any) => tweet.id === refTweet.id)?.text;
    // do not debunk own tweets
    if (refTweet?.author_id === BOT_ID) return;

    if (refTweetText) {
      console.log(refTweetText);

      const neuralNetPrompt = `Here's a tweet:
"""
${refTweetText}
"""
   
${PROMPT}`;

      let maxTweetSize = 280;
      let tokenSize = 4;
      const response = UrlFetchApp.fetch(`https://api.openai.com/v1/completions`, {
        method: "post",
        contentType: "application/json",
        headers: {
          "Authorization": `Bearer ${GPT_KEY}`
        },
        payload: JSON.stringify({
          model: "text-davinci-003",
          max_tokens: maxTweetSize / tokenSize,
          prompt: neuralNetPrompt
        })
      });

      const gptReply = JSON.parse(response.getContentText());
      const debunkText = gptReply?.choices?.[0]?.text;

      if (debunkText) {
        const tweet = `${debunkText.trim()}`;
        reply(tweet, m.id);
      }
    }

    lastMentionId = m.id;
  });

  if (lastMentionId) {
    CacheService.getScriptCache().put("lastMentionId", lastMentionId, MAX_EXPIRATION);
  }
};

/**
 * Create the OAuth2 Twitter Service
 * @return OAuth2 service
 */
function getService() {
  pkceChallengeVerifier();
  const store = PropertiesService.getScriptProperties();
  // @ts-ignore
  return OAuth2.createService("twitter")
    .setAuthorizationBaseUrl("https://twitter.com/i/oauth2/authorize")
    .setTokenUrl("https://api.twitter.com/2/oauth2/token?code_verifier=" + store.getProperty("code_verifier"))
    // Set the client ID and secret.
    .setClientId(CLIENT_ID)
    .setClientSecret(CLIENT_SECRET)
    .setCallbackFunction("authCallback")
    // Set the property store where authorized tokens should be persisted.
    .setPropertyStore(store)
    .setCache(CacheService.getScriptCache())
    // Set the scopes to request (space-separated for Twitter services).
    .setScope("users.read tweet.read offline.access tweet.write")

    // Add parameters in the authorization url
    .setParam("response_type", "code")
    .setParam("code_challenge_method", "S256")
    .setParam("code_challenge", store.getProperty("code_challenge"))
    .setTokenHeaders({
      "Authorization": "Basic " + Utilities.base64Encode(CLIENT_ID + ":" + CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded"
    });
}

/**
 * Reset the OAuth2 Twitter Service
 */
global.reset = function() {
  getService().reset();
  PropertiesService.getScriptProperties().deleteProperty("code_challenge");
  PropertiesService.getScriptProperties().deleteProperty("code_verifier");
};

/**
 * Generate PKCE Challenge Verifier for Permission for OAuth2 Twitter Service
 */
function pkceChallengeVerifier() {
  if (!code_verifier) {
    let verifier = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    for (let i = 0; i < 128; i++) {
      verifier += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    const sha256hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier);
    const challenge = Utilities.base64Encode(sha256hash)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const store = PropertiesService.getScriptProperties();
    store.setProperty("code_verifier", verifier);
    store.setProperty("code_challenge", challenge);
  }
}

/**
 * Handles the OAuth callback.
 */
global.authCallback = function(request) {
  const service = getService();
  const authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput("Success!");
  } else {
    return HtmlService.createHtmlOutput("Denied");
  }
};

/**
 * Send the Tweet
 * @Param tweet Text to tweet
 * @Param replyTo id of the tweet to reply
 * @return the ID of the current Tweet
 */
function reply(tweet: string, replyTo: string) {
  console.log(tweet);
  const url = `https://api.twitter.com/2/tweets`;
  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      "User-Agent": "v2TweetJS",
      authorization: `Bearer ${getService().getAccessToken()}`
    },
    payload: JSON.stringify({
      text: tweet,
      reply: { in_reply_to_tweet_id: replyTo }
    })
  });
  const result = JSON.parse(response.getContentText());
  console.log(result);
  return result.data.id;
}
