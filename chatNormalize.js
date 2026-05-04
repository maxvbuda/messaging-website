/**
 * Shared typo + slang normalization (same behavior as server `processOutgoingChatText` minus profanity masking).
 * Exposed globally as `slackflowChatNormalize(text)` when loaded via <script>; also `require`-able by Node.
 */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  try {
    if (typeof globalThis !== 'undefined') globalThis.slackflowChatNormalize = api.normalizeChatText;
  } catch (_) { /* noop */ }
})(function chatNormalizeModule() {
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const CHAT_TYPOS = (() => {
    const pairs = [
      ['accomodate', 'accommodate'], ['acommodate', 'accommodate'], ['acheive', 'achieve'],
      ['accross', 'across'], ['actualy', 'actually'], ['addional', 'additional'], ['adn', 'and'],
      ['alot', 'a lot'], ['amke', 'make'], ['annoint', 'anoint'], ['beleive', 'believe'],
      ['buisness', 'business'], ['calender', 'calendar'], ['cant', "can't"], ['comming', 'coming'],
      ['definately', 'definitely'], ['defiantly', 'definitely'], ['dependant', 'dependent'],
      ['disapear', 'disappear'], ["doesn't", "doesn't"], ['doesnt', "doesn't"], ['dont', "don't"],
      ["dosen't", "doesn't"], ['finaly', 'finally'], ['familar', 'familiar'], ['freind', 'friend'],
      ['giong', 'going'], ['happend', 'happened'], ['havent', "haven't"], ['heigth', 'height'],
      ['hlep', 'help'], ['hte', 'the'], ['imediate', 'immediate'], ['isnt', "isn't"], ['jsut', 'just'],
      ['occurrance', 'occurrence'], ["should'nt", "shouldn't"], ['shouldnt', "shouldn't"],
      ['soem', 'some'], ['theyre', "they're"], ['thiers', 'theirs'], ['thier', 'their'],
      ['thorugh', 'through'], ['recieve', 'receive'], ['seperate', 'separate'], ['teh', 'the'],
      ['occured', 'occurred'], ['untill', 'until'], ['waht', 'what'], ['wierd', 'weird'],
      ['wouldnt', "wouldn't"], ['wriet', 'write'], ['yuo', 'you'],
    ].sort((a, b) => b[0].length - a[0].length);
    return pairs;
  })();

  const CHAT_SLANG = Object.entries({
    dkdc: "don't know, don't care",
    idgaf: "don't care strongly",
    lmkwyt: 'let me know what you think',
    iykyk: 'if you know you know',
    istg: 'I swear to goodness',
    iirc: 'if I recall correctly',
    icymi: 'in case you missed it',
    imho: 'in my humble opinion',
    omfg: 'oh my gosh',
    omgwtf: 'oh my gosh what',
    lmfao: 'laughing my butt off',
    lmaooo: 'laughing my butt off',
    lmaoo: 'laughing my butt off',
    otw: 'on the way',
    omw: 'on my way',
    smmfh: 'shaking my head',
    srsly: 'seriously',
    asap: 'as soon as possible',
    bffls: 'best friends for life',
    bffs: 'best friends forever',
    bruh: 'bro',
    btwn: 'between',
    defo: 'definitely',
    dms: 'direct messages',
    finna: 'fixing to',
    frfr: 'for real for real',
    fwiw: 'for what it is worth',
    fyi: 'for your information',
    gtfo: 'get outta here',
    hbu: 'how about you',
    hby: 'how about you',
    hru: 'how are you',
    hmu: 'hit me up',
    idfk: "I don't freaking know",
    idky: "I don't know why",
    idk: "I don't know",
    idc: "I don't care",
    ima: "I'm gonna",
    irl: 'in real life',
    ilu: 'I love you',
    ily: 'I love you',
    icl: "I can't lie",
    imo: 'in my opinion',
    jkjk: 'just kidding',
    jw: 'just wondering',
    jfc: 'jeez',
    lmk: 'let me know',
    mfw: 'my face when',
    nahhh: 'no',
    nahh: 'no',
    nm: 'never mind',
    ngl: 'not gonna lie',
    nvm: 'never mind',
    npb: 'no problem',
    ong: 'on goodness',
    pplz: 'people please',
    plsfx: 'please fix',
    rofl: 'rolling on the floor laughing',
    smdh: 'shaking my darn head',
    smfh: 'shaking my head',
    smh: 'shaking my head',
    stfu: 'stop talking',
    tbh: 'to be honest',
    tbf: 'to be fair',
    tbfuu: 'to be freaking honest',
    tbd: 'to be decided',
    tldr: "too long; didn't read",
    tfw: 'that feeling when',
    tgif: 'thank goodness it is Friday',
    tia: 'thanks in advance',
    thx: 'thanks',
    tyvm: 'thank you very much',
    ttyl: 'talk to you later',
    ttyn: 'talk to you never',
    ty: 'thank you',
    tmw: 'tomorrow',
    tmi: 'too much info',
    wbu: 'what about you',
    wdym: 'what do you mean',
    wtf: 'what the heck',
    wtaf: 'what the heck',
    wyd: 'what are you doing',
    wya: 'where you at',
    wuu2: 'what are you up to',
    yktv: 'you know the vibes',
    yw: 'you are welcome',
    yt: 'you too',
    bc: 'because',
    btw: 'by the way',
    bf: 'boyfriend',
    brb: 'be right back',
    bbs: 'be back soon',
    bs: 'nonsense',
    coz: 'because',
    cuz: 'because',
    cya: 'see you',
    dk: 'do not know',
    dm: 'direct message',
    dw: 'do not worry',
    fmk: 'freaking heck',
    fml: 'freak my life',
    fk: 'freak',
    ffs: 'for goodness sake',
    fwb: 'friends with benefits',
    gf: 'girlfriend',
    gg: 'good game',
    gl: 'good luck',
    gn: 'good night',
    gr8: 'great',
    g2g: 'got to go',
    gtg: 'got to go',
    h8: 'hate',
    jk: 'just kidding',
    kk: 'okay',
    k: 'okay',
    lil: 'little',
    lmfaooo: 'laughing hard',
    lmao: 'laughing my butt off',
    lolll: 'laughing out loud',
    lol: 'laughing out loud',
    nmjc: 'not much just chilling',
    np: 'no problem',
    omg: 'oh my gosh',
    otp: 'on the phone',
    pls: 'please',
    plz: 'please',
    ppl: 'people',
    probs: 'probably',
    prob: 'probably',
    rn: 'right now',
    rly: 'really',
    srs: 'serious',
    sto: 'stop',
    tho: 'though',
    u: 'you',
    ur: 'your',
    welp: 'oh well',
    sup: 'what is up',
  }).sort((a, b) => b[0].length - a[0].length);

  function slangReplaceCase(orig, phrase) {
    const letters = orig.replace(/[^A-Za-z]/g, '');
    if (!letters) return phrase;
    if (letters === letters.toUpperCase() && letters.length > 1) return phrase.toUpperCase();
    if (/^[a-z]+$/.test(orig)) return phrase;
    return phrase.charAt(0).toUpperCase() + phrase.slice(1).toLowerCase();
  }

  function normalizeChatText(text) {
    if (!text) return '';
    let s = text;
    for (const [wrong, right] of CHAT_TYPOS) {
      s = s.replace(new RegExp('\\b' + escapeRe(wrong) + '\\b', 'gi'), right);
    }
    for (const [abbr, phrase] of CHAT_SLANG) {
      s = s.replace(new RegExp('\\b' + escapeRe(abbr) + '\\b', 'gi'), (m) => slangReplaceCase(m, phrase));
    }
    s = s.replace(/\blo+l\b/gi, (m) => slangReplaceCase(m, 'laughing out loud'));
    s = s.replace(/\bl+m+a+o+\b/gi, (m) => slangReplaceCase(m, 'laughing my butt off'));
    s = s.replace(/\br\s+n\b/gi, (m) => slangReplaceCase(m.replace(/\s+/g, ''), 'right now'));
    return s;
  }

  return { normalizeChatText };
});
