(function (g) {
  const rallyDmStories = [
    {
      id: 'sunken-payroll',
      title: 'The Sunken Payroll',
      tagline: 'Urban intrigue · docks',
      premise: 'The harbormaster disappeared the night a payroll chest went hollow. Guards blame petty thieves; sailors insist they heard dripping inside a bone-dry storeroom.',
      opening:
        'Lantern sway cuts through rigging shadows. On the harbormaster’s desk, tide charts disagree with the harbour bell by thirty minutes—as if someone wanted the docks empty at the wrong hour.',
      beats: [
        { title: 'Hook', body: 'A clerk quietly slides the roster across the desk. One name appears twice in different handwriting. Both “shifts” end at slack water.' },
        { title: 'Investigation', body: 'Behind a false plank in Dock 7 you find calf-high water with no ingress—until a coin dropped rings twice, bouncing off submerged steps under the floorboards.' },
        { title: 'Encounter', body: 'The chest at the cellar’s lowest step isn’t nailed shut; something inside swells gently with the tide rhythm. Mishandling sprays brine rope into living snares.' },
        { title: 'Finale', body: 'Peaceful resolution: decipher the chest’s rhyme and offer a truthful confession (any guilt on the dockside counts). Loud resolution: carve the rhyme into the planks and duel the haunt until it accepts a new pact.' },
      ],
      twist:
        'The “missing silver” dissolved into saline ink saturating fraudulent ledgers—a smuggler’s trick to bleach names right off the parchment until the harbourmaster noticed.',
      loot: 'A partial smugglers’ chart (your choice of destination), corroded master key fits three common locks, or a debt owed by the humbled harbormaster once freed.',
    },
    {
      id: 'kindly-portrait',
      title: 'The Kindly Portrait',
      tagline: 'Manor horror · etiquette',
      premise:
        'A minor noble wills the party lodging to settle an old diplomatic tab. Candlelight reveals that every ancestral portrait wears the exact same forgiving smile—even the knight whose jaw was shattered in battle.',
      opening:
        'Dust mites drift like snow in the ballroom. The eldest portrait dips its chin as you breathe, varnish catching your reflection a half-step late.',
      beats: [
        { title: 'Hook', body: 'House rules appear embroidered on napkins: Speak no ill of the departed. Praise the cook. Ignore singing from the servant bell after dark.' },
        { title: 'Investigation', body: 'Oil studies in the conservatory show unfinished faces—wet paint at midnight, signatures identical across centuries.' },
        { title: 'Encounter', body: 'The smiling collection syncs gazes toward whoever criticizes House policy. Critics feel their jaw stiffen toward a grin they did not earn.' },
        { title: 'Finale', body: 'Breaking the pact requires a truthful compliment and a ruthless insult uttered sincerely to different portraits—or burning the conservatory while nobody lies for one full candle.' },
      ],
      twist: 'The manor bound every heir into one forgiving mask so rebellion could never distort the lineage’s brand.',
      loot: 'Ring of immaculate posture (purely theatrical), dossier embarrassing a corrupt magistrate, or fey-touched perfumes that coax honest apologies.',
    },
    {
      id: 'festival-knots',
      title: 'Festival of Borrowed Knots',
      tagline: 'Fairground oddity · fey-lite',
      premise:
        'Ribbons at the village knot-tying festival bind luck for a season. Winners wake up oddly talented; losers swear their shadows lag one step behind. The mayor wants outsiders to judge without offending “Old Ribbon.”',
      opening:
        'Brass bells wind through candy smoke. Stall barkers hawk “knot lessons” promising fluency in languages nobody taught you—not yet.',
      beats: [
        { title: 'Hook', body: 'A child’s ribbon slips onto a PC’s wrist, granting an uncanny skill until sunset—paired with intrusive memories of chores they never lived.' },
        { title: 'Investigation', body: 'Contest logbooks list duplicate winners under fake names traced to the ribbon vendor’s cramped wagon.' },
        { title: 'Encounter', body: 'The ribbon loom animates mid-final, braiding fortunes that literally tighten when audience members envy aloud.' },
        { title: 'Finale', body: 'Negotiate stakes with Old Ribbon: trade one genuine secret whispered unanimously, beat the loom’s speed tying a four-dimensional reef knot nobody taught you, or out-humble the hag by praising losers first.' },
      ],
      twist: 'Old Ribbon siphoned enthusiasm from envious cheers to feed a fading forest gate beyond the midway.',
      loot: 'Lucky twine (three uses reroll mundane checks), hag-sweet fudge (advantage vs fear once), mayor’s handwritten favour.',
    },
    {
      id: 'beekeeper-accords',
      title: "The Beekeeper's Accords",
      tagline: 'Wilderness trade · swarm logic',
      premise:
        'Two villages feud over pollinator paths. A tacit giant-bee diplomat vanished; both sides received identical wax seals promising “sweet arbitration.” Trails of golden wax point toward shattered hives sculpted like amphitheatres.',
      opening:
        'Your boots stick to tessellated hexes pressed into pollen dust. Bees spell brief words in drifting flight—WAIT, SWAP, SHARE—then scatter before you blink.',
      beats: [
        { title: 'Hook', body: 'Each village offers honey with incompatible aftertastes: one induces honesty, the other nostalgia. Bees refuse mixes.' },
        { title: 'Investigation', body: 'Collapsed hive stages show wax effigies of both mayors clasping hands sculpted too late in the duel timeline.' },
        { title: 'Encounter', body: 'A rogue swarm manifests as choral armor when someone loudly picks a winner before hearing both woes.' },
        { title: 'Finale', body: 'Rebuild the diplomat’s pact: synchronize harvest windows, duel with pollen duets instead of arrows, or offer a yearly tithe sung at dusk.' },
      ],
      twist: 'The vanished diplomat liquefied into shared mead—you already drank prophecy without realizing.',
      loot: 'Vial hive-queen etiquette (summon orderly bee scouts once), braided flight lines map hidden trails, everlasting honeycomb ration.',
    },
    {
      id: 'cartographers-fault',
      title: "The Cartographer's Fault",
      tagline: 'Exploration puzzler · memory',
      premise:
        'A celebrated map etched on living bark updates terrain—but erases explorers’ anecdotes the longer they stare. Expedition sponsors beg the party to finish the atlas before backers forget sponsoring anything at all.',
      opening:
        'Your thumb smears unfinished ink uphill that should not exist. Nearby birds forget mid-chirp, cutting songs into chirp-shaped silence stamps.',
      beats: [
        { title: 'Hook', body: 'An NPC guide forgets nouns progressively; handwriting on their journal rewrites geography each dawn.' },
        { title: 'Investigation', body: 'Older map shards describe the same gorge as both river and plaza—overlap zones birth harmless illusions mocking consensus.' },
        { title: 'Encounter', body: 'The birch scroll animates topography like origami jaws when multiple maps disagree held aloft simultaneously.' },
        { title: 'Finale', body: 'Seal the atlas by forging a unanimous lie everyone believes for exactly six seconds, drowning the grove in choral truth afterward to wash the lie clean.' },
      ],
      twist: 'The grove feeds on contradictory stories; harmony starves but clarity kills wonder—deal struck must rotate narrators nightly.',
      loot: 'Pocket lodestone aligning to emotional north, mnemonic tea leaves, parchment contract signed by oblivion spirits (void any fine print once).',
    },
    {
      id: 'last-toll',
      title: 'The Last Toll',
      tagline: 'Ghost-road · bardic duel',
      premise:
        'A spectral tollkeeper bars a canyon bridge reputed to shorten travel by days. Souls pay in laughter, riddles broken, not coin. Merchant guilds riot; locals whisper the keeper mourns punchlines murdered by cynicism.',
      opening:
        'Mist peels into ticket stubs fluttering downward like leaves. Echoes mimic your footsteps but hum off-key harmonies you never learned.',
      beats: [
        { title: 'Hook', body: 'First crossing drains no gold—instead it steals punchlines PCs remember vividly, leaving dangling setups mid-conversation.' },
        { title: 'Investigation', body: 'Chalk murals under the bridge show the keeper mid-laughter before a betrayal scene inked cruelly blunt.' },
        { title: 'Encounter', body: 'The keeper challenges a joke-off where failed punchlines lash as harmless phantom pie tins—until disrespect stacks them heavy.' },
        { title: 'Finale', body: 'Earn passage by restoring a bittersweet anecdote truthful enough to ache, gifting the keeper catharsis, or trading your warmest campfire story forever.' },
      ],
      twist: 'The keeper is the punchline resurrected prematurely by necromancers who misunderstood timing.',
      loot: 'Feather laughs once per moon, braided bridge twine immune to gale, charter exempting mundane bridge fees regionally.',
    },
    {
      id: 'moonlit-auction',
      title: 'Moonlit Ledger Auction',
      tagline: 'Heist social · betrayal buffet',
      premise:
        'Thieves covenant auctions a forbidden lot—“first draft of prophecy.” Guards and crooks mingle under glamours. Invite-only ink bleeds attendee names alive on programs. Buyers vanish politely between courses.',
      opening:
        'Velvet drapery breathes incense that tastes like vows about to fracture. Servers swap plates when eye contact slips—every switch another tiny heist rehearsal.',
      beats: [
        { title: 'Hook', body: 'Forgeries circulate before lots open; rumor says one forgery predicts the bidder’s betrayal verbatim.' },
        { title: 'Investigation', body: 'Wine cellar vintages correlate with eras prophecies rewrote wars—some bottles contain rolled palimpsests still wet.' },
        { title: 'Encounter', body: 'Bidding climax suspends gravity when someone speaks a price literally impossible to owe—spectral accountants descend.' },
        { title: 'Finale', body: 'Win the prophecy by forging a sweeter lie than truth, gifting the thieves a confession they feared, or blackmail duel using audience secrets pulled from napkins.' },
      ],
      twist: 'The prophecy’s first draft is blank—auctioneers improvised fate to refinance their guildhall.',
      loot: 'Seal nullifying verbal contracts briefly, monocle glimpsing improvised lies, cloak pocketing swallowed pride once.',
    },
    {
      id: 'silent-symphony',
      title: 'The Silent Symphony Mine',
      tagline: 'Underground sonic horror',
      premise:
        'Miners strike a resonance geode humming below hearing. Tools vibrate politely; explosives refuse detonation aloud. Overseers hire adventurers willing to scout “Quiet Level Nine” carrying tuned forks nobody taught them to wield.',
      opening:
        'Your teeth ache with arithmetic you cannot hum. Lantern flame stands vertical, soot sketching staffs across glass like impatient composers.',
      beats: [
        { title: 'Hook', body: 'Shift whistle never arrives—bells ring only when spoken lies echo off stone.' },
        { title: 'Investigation', body: 'Carved hymn lines spiral into shafts that narrow when yelled into, widen under whisper confessions.' },
        { title: 'Encounter', body: 'Chord clusters manifest as luminous crystal bats when harmony instruments overlap—friendly until someone claps sarcastic applause.' },
        { title: 'Finale', body: 'Conduct the geode symphony: align four PCs on harmony beats under stress, sabotage sabotage explosives with pure silence duel, or trade hearing in one ear for one season to stabilize the resonance.' },
      ],
      twist: 'The symphony replays regrets of everyone who drowned song here—recording ends when newcomers sing something brand new.',
      loot: 'Tuning fork keyed to planar static, earmuffs filtering magical suggestion, powdered resonance salt spices thunder once.',
    },
  ];
  g.rallyDmHandbook = rallyDmStories;
  g.slackflowDmHandbook = rallyDmStories;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
