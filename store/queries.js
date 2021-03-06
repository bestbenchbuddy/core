/**
 * Provides functions to get/insert data into data stores.
 **/
const utility = require('../util/utility');
const benchmarks = require('../util/benchmarks');
const config = require('../config');
const constants = require('dotaconstants');
const queue = require('./queue');
const async = require('async');
const moment = require('moment');
const util = require('util');
const filter = require('../util/filter');
const compute = require('../util/compute');
const db = require('../store/db');
const redis = require('../store/redis');
const cassandra = require('../store/cassandra');

const pQueue = queue.getQueue('parse');
const convert64to32 = utility.convert64to32;
const serialize = utility.serialize;
const deserialize = utility.deserialize;
const reduceAggregable = utility.reduceAggregable;
const computeMatchData = compute.computeMatchData;
const columnInfo = {};
const cassandraColumnInfo = {};

function doCleanRow(err, schema, row, cb) {
  if (err) {
    return cb(err);
  }
  const obj = {};
  Object.keys(row).forEach((key) => {
    if (key in schema) {
      obj[key] = row[key];
    }
  });
  return cb(err, obj);
}

function cleanRow(db, table, row, cb) {
  if (columnInfo[table]) {
    return doCleanRow(null, columnInfo[table], row, cb);
  }
  return db(table).columnInfo().asCallback((err, result) => {
    if (err) {
      return cb(err);
    }
    columnInfo[table] = result;
    return doCleanRow(err, columnInfo[table], row, cb);
  });
}

function cleanRowCassandra(cassandra, table, row, cb) {
  if (cassandraColumnInfo[table]) {
    return doCleanRow(null, cassandraColumnInfo[table], row, cb);
  }
  return cassandra.execute('SELECT column_name FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?', [config.NODE_ENV === 'test' ? 'yasp_test' : 'yasp', table], (err, result) => {
    if (err) {
      return cb(err);
    }
    cassandraColumnInfo[table] = {};
    result.rows.forEach((r) => {
      cassandraColumnInfo[table][r.column_name] = 1;
    });
    return doCleanRow(err, cassandraColumnInfo[table], row, cb);
  });
}

/**
 * Benchmarks a match against stored data in Redis.
 **/
function getMatchBenchmarks(redis, m, cb) {
  async.map(m.players, (p, cb) => {
    p.benchmarks = {};
    async.eachSeries(Object.keys(benchmarks), (metric, cb) => {
      // Use data from previous epoch
      const key = ['benchmarks', utility.getStartOfBlockMinutes(config.BENCHMARK_RETENTION_MINUTES, -1), metric, p.hero_id].join(':');
      const raw = benchmarks[metric](m, p);
      p.benchmarks[metric] = {
        raw,
      };
      redis.zcard(key, (err, card) => {
        if (err) {
          return cb(err);
        }
        if (raw !== undefined && raw !== null && !isNaN(Number(raw))) {
          return redis.zcount(key, '0', raw, (err, count) => {
            if (err) {
              return cb(err);
            }
            const pct = count / card;
            p.benchmarks[metric].pct = pct;
            return cb(err);
          });
        }
        p.benchmarks[metric] = {};
        return cb();
      });
    }, cb);
  }, cb);
}

function getDistributions(redis, cb) {
  const keys = ['distribution:mmr', 'distribution:country_mmr'];
  const result = {};
  async.each(keys, (r, cb) => {
    redis.get(r, (err, blob) => {
      if (err) {
        return cb(err);
      }
      result[r.split(':')[1]] = JSON.parse(blob);
      return cb(err);
    });
  }, err =>
    cb(err, result)
  );
}

function getProPlayers(db, redis, cb) {
  db.raw(`
    SELECT * from notable_players
    `).asCallback((err, result) => {
      if (err) {
        return cb(err);
      }
      return cb(err, result.rows);
    });
}

function getLeaderboard(db, redis, key, n, cb) {
  redis.zrevrangebyscore(key, 'inf', '-inf', 'WITHSCORES', 'LIMIT', '0', n, (err, rows) => {
    if (err) {
      return cb(err);
    }
    const entries = rows.map((r, i) =>
      ({
        account_id: r,
        score: rows[i + 1],
      })
    ).filter((r, i) =>
      i % 2 === 0
    );
    const accountIds = entries.map(r =>
      r.account_id
    );
    // get player data from DB
    return db.select().from('players').whereIn('account_id', accountIds).asCallback((err, names) => {
      if (err) {
        return cb(err);
      }
      const obj = {};
      names.forEach((n) => {
        obj[n.account_id] = n;
      });
      entries.forEach((e) => {
        Object.keys(obj[e.account_id]).forEach((key) => {
          e[key] = e[key] || obj[e.account_id][key];
        });
      });
      return cb(err, entries);
    });
  });
}

function getHeroRankings(db, redis, heroId, options, cb) {
  getLeaderboard(db, redis, [options.beta ? 'hero_rankings2' : 'hero_rankings', moment().startOf('quarter').format('X'), heroId].join(':'), 100, (err, entries) => {
    if (err) {
      return cb(err);
    }
    return async.each(entries, (player, cb) => {
      async.parallel({
        solo_competitive_rank(cb) {
          redis.zscore('solo_competitive_rank', player.account_id, cb);
        },
      }, (err, result) => {
        if (err) {
          return cb(err);
        }
        player.solo_competitive_rank = result.solo_competitive_rank;
        return cb(err);
      });
    }, err =>
      cb(err, {
        hero_id: Number(heroId),
        rankings: entries,
      })
    );
  });
}

function getHeroBenchmarks(db, redis, options, cb) {
  const heroId = options.hero_id;
  const ret = {};
  async.each(Object.keys(benchmarks), (metric, cb) => {
    const arr = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
    async.each(arr, (percentile, cb) => {
        // Use data from previous epoch
      const key = ['benchmarks', utility.getStartOfBlockMinutes(config.BENCHMARK_RETENTION_MINUTES, -1), metric, heroId].join(':');
      redis.zcard(key, (err, card) => {
        if (err) {
          return cb(err);
        }
        const position = Math.floor(card * percentile);
        return redis.zrange(key, position, position, 'WITHSCORES', (err, result) => {
          const obj = {
            percentile,
            value: Number(result[1]),
          };
          if (!ret[metric]) {
            ret[metric] = [];
          }
          ret[metric].push(obj);
          cb(err, obj);
        });
      });
    }, cb);
  }, err =>
    cb(err, {
      hero_id: Number(heroId),
      result: ret,
    })
  );
}

function getMmrEstimate(db, redis, accountId, cb) {
  redis.lrange(`mmr_estimates:${accountId}`, 0, -1, (err, result) => {
    if (err) {
      return cb(err);
    }
    const data = result.filter(d =>
      // remove invalid values
      d
    ).map(d =>
      // convert to numerical values
      Number(d)
    );
    return cb(err, {
      estimate: utility.average(data),
      stdDev: utility.stdDev(data),
      n: data.length,
    });
  });
}

function getMatchesSkill(db, matches, options, cb) {
  // fill in skill data from table
  // only necessary if reading from cache since adding skill data doesn't update cache
  console.time('[PLAYER] fillSkill');
  // get skill data for matches within cache expiry (might not have skill data)
  /*
  var recents = matches.filter(function(m)
  {
      return moment().diff(moment.unix(m.start_time), 'days') <= config.UNTRACK_DAYS;
  });
  */
  // just get skill for last N matches to speed up DB query
  const recents = matches.slice(0, 50);
  const skillMap = {};
  db.select(['match_id', 'skill']).from('match_skill').whereIn('match_id', recents.map(m =>
    m.match_id
  )).asCallback((err, rows) => {
    if (err) {
      return cb(err);
    }
    console.log('fillSkill recents: %s, results: %s', recents.length, rows.length);
    rows.forEach((match) => {
      skillMap[match.match_id] = match.skill;
    });
    matches.forEach((m) => {
      m.skill = m.skill || skillMap[m.match_id];
    });
    console.timeEnd('[PLAYER] fillSkill');
    return cb(err, matches);
  });
}

function getPlayerMatches(accountId, queryObj, cb) {
  if (config.ENABLE_CASSANDRA_MATCH_STORE_READ && cassandra) {
    // call clean method to ensure we have column info cached
    return cleanRowCassandra(cassandra, 'player_caches', {}, (err) => {
      if (err) {
        return cb(err);
      }
      // console.log(queryObj.project, cassandraColumnInfo.player_caches);
      const query = util.format('SELECT %s FROM player_caches WHERE account_id = ? ORDER BY match_id DESC',
        queryObj.project.filter(f => cassandraColumnInfo.player_caches[f]).join(','));
      let matches = [];
      return cassandra.stream(query, [accountId], {
        prepare: true,
        fetchSize: 1000,
        autoPage: true,
      }).on('readable', function handleRow() {
        // readable is emitted as soon a row is received and parsed
        while (true) {
          const read = this.read();
          if (!read) {
            break;
          }
          const m = deserialize(read);
          if (filter([m], queryObj.filter).length) {
            matches.push(m);
          }
        }
      }).on('end', (err) => {
        // stream ended, there aren't any more rows
        if (queryObj.sort) {
          matches.sort((a, b) =>
            b[queryObj.sort] - a[queryObj.sort]
          );
        }
        matches = matches.slice(queryObj.offset, queryObj.limit || matches.length);
        return cb(err, matches);
      }).on('error', cb);
    });
  }
  // TODO support reading from postgres
  return cb(null, []);
}

function getPlayerRatings(db, accountId, cb) {
  console.time(`[PLAYER] getPlayerRatings ${accountId}`);
  if (!isNaN(Number(accountId))) {
    db.from('player_ratings').where({
      account_id: Number(accountId),
    }).orderBy('time', 'asc').asCallback((err, result) => {
      console.timeEnd(`[PLAYER] getPlayerRatings ${accountId}`);
      cb(err, result);
    });
  } else {
    cb();
  }
}

function getPlayerRankings(redis, accountId, cb) {
  async.map(Object.keys(constants.heroes), (heroId, cb) => {
    redis.zcard(['hero_rankings', moment().startOf('quarter').format('X'), heroId].join(':'), (err, card) => {
      if (err) {
        return cb(err);
      }
      return redis.zrank(['hero_rankings', moment().startOf('quarter').format('X'), heroId].join(':'), accountId, (err, rank) => {
        cb(err, {
          hero_id: heroId,
          rank,
          card,
        });
      });
    });
  }, cb);
}

function getPlayer(db, accountId, cb) {
  if (!isNaN(Number(accountId))) {
    db.first('players.account_id', 'personaname', 'name', 'cheese', 'steamid', 'avatar', 'avatarmedium', 'avatarfull', 'profileurl', 'last_login', 'loccountrycode')
      .from('players')
      .leftJoin('notable_players', 'players.account_id', 'notable_players.account_id')
      .where({
        'players.account_id': Number(accountId),
      })
      .asCallback(cb);
  } else {
    cb();
  }
}

function getPeers(db, input, player, cb) {
  if (!input) {
    return cb();
  }
  let teammatesArr = [];
  const teammates = input;
  Object.keys(teammates).forEach((id) => {
    const tm = teammates[id];
    const numId = Number(id);
    // don't include if anonymous, self or if few games together
    if (numId &&
      numId !== Number(player.account_id) &&
      numId !== utility.getAnonymousAccountId() &&
      tm.games >= 5) {
      teammatesArr.push(tm);
    }
  });
  teammatesArr.sort((a, b) =>
    b.games - a.games
  );
  // limit to 200 max players
  teammatesArr = teammatesArr.slice(0, 200);
  return async.each(teammatesArr, (t, cb) => {
    db.first().from('players').where({
      account_id: t.account_id,
    }).asCallback((err, row) => {
      if (err || !row) {
        return cb(err);
      }
      t.personaname = row.personaname;
      t.last_login = row.last_login;
      t.avatar = row.avatar;
      return cb(err);
    });
  }, (err) => {
    cb(err, teammatesArr);
  });
}

function getProPeers(db, input, player, cb) {
  if (!input) {
    return cb();
  }
  const teammates = input;
  return db.raw(`select *, notable_players.account_id
          FROM notable_players
          LEFT JOIN players
          ON notable_players.account_id = players.account_id
          `).asCallback((err, result) => {
            if (err) {
              return cb(err);
            }
            const arr = result.rows.map(r =>
      Object.assign({}, r, teammates[r.account_id])
    ).filter(r =>
      r.games
    ).sort((a, b) =>
      b.games - a.games
    );
            return cb(err, arr);
          });
}

function getMatchRating(redis, match, cb) {
  async.map(match.players, (player, cb) => {
    if (!player.account_id) {
      return cb();
    }
    return redis.zscore('solo_competitive_rank', player.account_id, cb);
  }, (err, result) => {
    if (err) {
      return cb(err);
    }
    // Remove undefined/null values
    const filt = result.filter(r =>
      r
    );
    const avg = Math.floor(filt.map(r =>
      Number(r)
    ).reduce((a, b) =>
      a + b, 0) / filt.length);
    return cb(err, avg, filt.length);
  });
}

function upsert(db, table, row, conflict, cb) {
  cleanRow(db, table, row, (err, row) => {
    if (err) {
      return cb(err);
    }
    const values = Object.keys(row).map(() =>
      '?'
    );
    const update = Object.keys(row).map(key =>
      util.format('%s=%s', key, `EXCLUDED.${key}`)
    );
    const query = util.format('INSERT INTO %s (%s) VALUES (%s) ON CONFLICT (%s) DO UPDATE SET %s',
      table,
      Object.keys(row).join(','),
      values,
      Object.keys(conflict).join(','),
      update.join(',')
    );
    // if (table==='cosmetics') console.log(query.toString(), row);
    return db.raw(query, Object.keys(row).map(key =>
      row[key]
    )).asCallback(cb);
  });
}
/*
function updateMatchups(match, cb) {
  async.each(utility.generateMatchups(match, 1), (key, cb) => {
    db.raw(`INSERT INTO matchups (matchup, num)
    VALUES (?, 1)
    ON CONFLICT(matchup)
    DO UPDATE SET num = matchups.num + 1
    `, [key]).asCallback(cb);
    cassandra.execute(`UPDATE matchups
    SET num = num + 1
    WHERE matchup = ?
    `, [key], {prepare: true}, cb);
    redis.hincrby('matchups', key, 2, cb);
  }, cb);
}
*/
function updateRankings(match, cb) {
  getMatchRating(redis, match, (err, avg) => {
    if (err) {
      return cb(err);
    }
    const matchScore = (avg && !isNaN(Number(avg))) ?
      Math.pow(Math.max(avg / 1000, 1), 7) :
      undefined;
    return async.each(match.players, (player, cb) => {
      if (!player.account_id || player.account_id === utility.getAnonymousAccountId()) {
        return cb();
      }
      player.radiant_win = match.radiant_win;
      const start = moment().startOf('quarter').format('X');
      const expire = moment().add(1, 'quarter').startOf('quarter').format('X');
      const win = Number(utility.isRadiant(player) === player.radiant_win);
      const playerScore = win ? matchScore : 0;
      if (playerScore && utility.isSignificant(match)) {
        const rankingKey = ['hero_rankings', start, player.hero_id].join(':');
        redis.zincrby(rankingKey, playerScore, player.account_id);
        redis.expireat(rankingKey, expire);
      }
      return cb();
    }, cb);
  });
}

function updateBenchmarks(match, cb) {
  for (let i = 0; i < match.players.length; i += 1) {
    const p = match.players[i];
    // only do if all players have heroes
    if (p.hero_id) {
      Object.keys(benchmarks).forEach((key) => {
        const metric = benchmarks[key](match, p);
        if (metric !== undefined && metric !== null && !isNaN(Number(metric))) {
          const rkey = [
            'benchmarks',
            utility.getStartOfBlockMinutes(config.BENCHMARK_RETENTION_MINUTES, 0),
            key,
            p.hero_id,
          ].join(':');
          redis.zadd(rkey, metric, match.match_id);
          // expire at time two epochs later (after prev/current cycle)
          const expiretime = utility.getStartOfBlockMinutes(config.BENCHMARK_RETENTION_MINUTES, 2);
          redis.expireat(rkey, expiretime);
        }
      });
    }
  }
  return cb();
}

function updateMatchRating(match, cb) {
  getMatchRating(redis, match, (err, avg, num) => {
    if (avg && !isNaN(Number(avg))) {
      // For each player, update mmr estimation list
      match.players.forEach((player) => {
        if (player.account_id && player.account_id !== utility.getAnonymousAccountId()) {
          // push into list, limit elements
          redis.lpush(`mmr_estimates:${player.account_id}`, avg);
          redis.ltrim(`mmr_estimates:${player.account_id}`, 0, 19);
        }
      });
      // Persist match average MMR into postgres
      return upsert(db, 'match_rating', {
        match_id: match.match_id,
        rating: avg,
        num_players: num,
      }, {
        match_id: match.match_id,
      }, cb);
    }
    return cb(err);
  });
}

function insertPlayer(db, player, cb) {
  if (player.steamid) {
    // this is a login, compute the account_id from steamid
    player.account_id = Number(convert64to32(player.steamid));
  }
  if (!player.account_id || player.account_id === utility.getAnonymousAccountId()) {
    return cb();
  }
  return upsert(db, 'players', player, {
    account_id: player.account_id,
  }, cb);
}

function insertPlayerRating(db, row, cb) {
  db('player_ratings').insert(row).asCallback(cb);
}

function insertMatchSkill(db, row, cb) {
  upsert(db, 'match_skill', row, {
    match_id: row.match_id,
  }, cb);
}

function writeCache(accountId, cache, cb) {
  if (!cassandra) {
    return cb();
  }
  return async.each(cache.raw, (m, cb) => {
    m = serialize(reduceAggregable(m));
    const query = util.format('INSERT INTO player_caches (%s) VALUES (%s)',
      Object.keys(m).join(','),
      Object.keys(m).map(() => '?').join(',')
    );
    cassandra.execute(query, Object.keys(m).map(k =>
      m[k]
    ), {
      prepare: true,
    }, cb);
  }, (err) => {
    if (err) {
      console.error(err.stack);
    }
    return cb(err);
  });
}

function insertPlayerCache(match, cb) {
  if (!cassandra) {
    return cb();
  }
  const players = match.players;
  if (match.pgroup && players) {
    players.forEach((p) => {
      if (match.pgroup[p.player_slot]) {
        // add account id to each player so we know what caches to update
        p.account_id = match.pgroup[p.player_slot].account_id;
        // add hero_id to each player so we update records with hero played
        p.hero_id = match.pgroup[p.player_slot].hero_id;
      }
    });
  }
  return async.eachSeries(players, (playerMatch, cb) => {
    if (playerMatch.account_id && playerMatch.account_id !== utility.getAnonymousAccountId()) {
      // join player with match to form player_match
      Object.keys(match).forEach((key) => {
        if (key !== 'players') {
          playerMatch[key] = match[key];
        }
      });
      computeMatchData(playerMatch);
      return writeCache(playerMatch.account_id, {
        raw: [playerMatch],
      }, cb);
    }
    return cb();
  }, cb);
}

function createMatchCopy(match, players, options) {
  const copy = JSON.parse(JSON.stringify(match));
  copy.players = JSON.parse(JSON.stringify(players));
  copy.insert_type = options.type;
  copy.origin = options.origin;
  return copy;
}

function insertMatch(match, options, cb) {
  const players = match.players ? JSON.parse(JSON.stringify(match.players)) : undefined;

  function preprocess(cb) {
    // don't insert anonymous account id
    if (players) {
      players.forEach((p) => {
        if (p.account_id === utility.getAnonymousAccountId()) {
          delete p.account_id;
        }
      });
    }
    // if we have a pgroup from earlier, use it to fill out hero_ids (used after parse)
    if (players && match.pgroup) {
      players.forEach((p) => {
        if (match.pgroup[p.player_slot]) {
          p.hero_id = match.pgroup[p.player_slot].hero_id;
        }
      });
    }
    // build match.pgroup so after parse we can figure out the account_ids for each slot
    if (players && !match.pgroup) {
      match.pgroup = {};
      players.forEach((p) => {
        match.pgroup[p.player_slot] = {
          account_id: p.account_id || null,
          hero_id: p.hero_id,
          player_slot: p.player_slot,
        };
      });
    }
    // ability_upgrades_arr
    if (players) {
      players.forEach((p) => {
        if (p.ability_upgrades) {
          p.ability_upgrades_arr = p.ability_upgrades.map(au =>
            au.ability
          );
        }
      });
    }
    cb();
  }

  function decideLogParse(cb) {
    if (match.leagueid
      && match.human_players === 10
      && match.duration > 300
      && (match.game_mode === 0 || match.game_mode === 1 || match.game_mode === 2)
      && match.players
      && match.players.every(p => p.hero_id > 0)) {
      redis.sismember('pro_leagueids', match.leagueid, (err, result) => {
        options.doLogParse = options.doLogParse || Boolean(Number(result));
        cb(err);
      });
    } else {
      cb();
    }
  }

  function upsertMatch(cb) {
    if (!config.ENABLE_POSTGRES_MATCH_STORE_WRITE && !options.doLogParse) {
      return cb();
    }
    return db.transaction((trx) => {
      function upsertMatch(cb) {
        upsert(trx, 'matches', match, {
          match_id: match.match_id,
        }, cb);
      }

      function upsertPlayerMatches(cb) {
        async.each(players || [], (pm, cb) => {
          pm.match_id = match.match_id;
          upsert(trx, 'player_matches', pm, {
            match_id: pm.match_id,
            player_slot: pm.player_slot,
          }, cb);
        }, cb);
      }

      function upsertPicksBans(cb) {
        async.each(match.picks_bans || [], (p, cb) => {
          // order is a reserved keyword
          p.ord = p.order;
          p.match_id = match.match_id;
          upsert(trx, 'picks_bans', p, {
            match_id: p.match_id,
            ord: p.ord,
          }, cb);
        }, cb);
      }

      function upsertMatchPatch(cb) {
        if (match.start_time) {
          return upsert(trx, 'match_patch', {
            match_id: match.match_id,
            patch: constants.patch[utility.getPatchIndex(match.start_time)].name,
          }, {
            match_id: match.match_id,
          }, cb);
        }
        return cb();
      }

      function upsertTeamMatch(cb) {
        const arr = [];
        if (match.radiant_team_id) {
          arr.push({
            team_id: match.radiant_team_id,
            match_id: match.match_id,
            radiant: true,
          });
        }
        if (match.dire_team_id) {
          arr.push({
            team_id: match.dire_team_id,
            match_id: match.match_id,
            radiant: false,
          });
        }
        async.each(arr, (tm, cb) => {
          upsert(trx, 'team_match', tm, {
            team_id: tm.team_id,
            match_id: tm.match_id,
          }, cb);
        }, cb);
      }

      function upsertMatchLogs(cb) {
        if (!match.logs) {
          return cb();
        }
        return trx.raw('DELETE FROM match_logs WHERE match_id = ?', [match.match_id])
          .asCallback((err) => {
            if (err) {
              return cb(err);
            }
            return async.eachLimit(match.logs, 10000, (e, cb) => {
              trx('match_logs').insert(e).asCallback(cb);
            }, cb);
          });
      }

      function exit(err) {
        if (err) {
          console.error(err);
          trx.rollback(err);
        } else {
          trx.commit();
        }
        cb(err);
      }

      async.series({
        m: upsertMatch,
        pm: upsertPlayerMatches,
        pb: upsertPicksBans,
        mp: upsertMatchPatch,
        utm: upsertTeamMatch,
        l: upsertMatchLogs,
      }, exit);
    });
  }

  function upsertMatchCassandra(cb) {
    if (!config.ENABLE_CASSANDRA_MATCH_STORE_WRITE) {
      return cb();
    }
    // console.log('[INSERTMATCH] upserting into Cassandra');
    return cleanRowCassandra(cassandra, 'matches', match, (err, match) => {
      if (err) {
        return cb(err);
      }
      const obj = serialize(match);
      if (!Object.keys(obj).length) {
        return cb(err);
      }
      const query = util.format('INSERT INTO matches (%s) VALUES (%s)',
        Object.keys(obj).join(','),
        Object.keys(obj).map(() => '?').join(',')
      );
      const arr = Object.keys(obj).map(k =>
        // boolean types need to be expressed as booleans
        // if strings the cassandra driver will always convert it to true, e.g. 'false'
        ((obj[k] === 'true' || obj[k] === 'false') ? JSON.parse(obj[k]) : obj[k])
      );
      return cassandra.execute(query, arr, {
        prepare: true,
      }, (err) => {
        if (err) {
          return cb(err);
        }
        return async.each(players || [], (pm, cb) => {
          pm.match_id = match.match_id;
          cleanRowCassandra(cassandra, 'player_matches', pm, (err, pm) => {
            if (err) {
              return cb(err);
            }
            const obj2 = serialize(pm);
            if (!Object.keys(obj2).length) {
              return cb(err);
            }
            const query2 = util.format('INSERT INTO player_matches (%s) VALUES (%s)',
              Object.keys(obj2).join(','),
              Object.keys(obj2).map(() => '?').join(',')
            );
            const arr2 = Object.keys(obj2).map(k =>
              obj2[k]
            );
            return cassandra.execute(query2, arr2, {
              prepare: true,
            }, cb);
          });
        }, cb);
      });
    });
  }

  function updatePlayerCaches(cb) {
    if (!config.ENABLE_CASSANDRA_MATCH_STORE_WRITE) {
      return cb();
    }
    const copy = createMatchCopy(match, players, options);
    return insertPlayerCache(copy, cb);
  }

  function updateCounts(cb) {
    if (options.skipCounts) {
      return cb();
    }
    return async.parallel({
      updateRankings(cb) {
        if (options.origin === 'scanner') {
          return updateRankings(match, cb);
        }
        return cb();
      },
      updateMatchRating(cb) {
        if (options.origin === 'scanner') {
          return updateMatchRating(match, cb);
        }
        return cb();
      },
      updateBenchmarks(cb) {
        if (options.origin === 'scanner') {
          return updateBenchmarks(match, cb);
        }
        return cb();
      },
      /*
      updateMatchups(cb) {
        if (options.origin === 'scanner') {
          return updateMatchups(match, cb);
        }
        return cb();
      },
      */
    }, cb);
  }

  function telemetry(cb) {
    // console.log('[INSERTMATCH] updating telemetry');
    const types = {
      api: 'matches_last_added',
      parsed: 'matches_last_parsed',
    };
    if (types[options.type]) {
      redis.lpush(types[options.type], JSON.stringify({
        match_id: match.match_id,
        duration: match.duration,
        start_time: match.start_time,
      }));
      redis.ltrim(types[options.type], 0, 9);
    }
    if (options.type === 'parsed') {
      redis.zadd('parser', moment().format('X'), match.match_id);
    }
    if (options.origin === 'scanner') {
      redis.zadd('added_match', moment().format('X'), match.match_id);
    }
    async.some(match.players, (p, cb) => {
      redis.zscore('visitors', String(p.account_id), (err, score) =>
        cb(err, Boolean(score))
      );
    }, (err, result) => {
      if (result) {
        redis.zadd('visitor_match', moment().format('X'), match.match_id);
      }
      return cb(err);
    });
  }

  function clearMatchCache(cb) {
    redis.del(`match:${match.match_id}`, cb);
  }

  function decideMmr(cb) {
    async.each(match.players, (p, cb) => {
      if (options.origin === 'scanner' &&
        match.lobby_type === 7 &&
        p.account_id &&
        p.account_id !== utility.getAnonymousAccountId() &&
        config.ENABLE_RANDOM_MMR_UPDATE) {
        redis.lpush('mmrQueue', JSON.stringify({
          match_id: match.match_id,
          account_id: p.account_id,
        }));
        cb();
      } else {
        cb();
      }
    }, cb);
  }

  function decideProfile(cb) {
    async.each(match.players, (p, cb) => {
      if (options.origin === 'scanner' &&
        p.account_id &&
        p.account_id !== utility.getAnonymousAccountId()) {
        redis.lpush('profilerQueue', p.account_id);
        redis.ltrim('profilerQueue', 0, 99);
      }
      cb();
    }, cb);
  }

  function decideGcData(cb) {
    // TODO use reliable queue
    if (options.origin === 'scanner' && (match.match_id % 100) < Number(config.GCDATA_PERCENT)) {
      redis.lpush('gcQueue', JSON.stringify({
        match_id: match.match_id,
      }));
      cb();
    } else {
      cb();
    }
  }

  function decideMetaParse(cb) {
    // metaQueue.add()
    cb();
  }

  function decideReplayParse(cb) {
    if (options.skipParse) {
      // not parsing this match
      return cb();
    }
    // determine if any player in the match is tracked
    return async.some(match.players, (p, cb) => {
      redis.zscore('tracked', String(p.account_id), (err, score) =>
        cb(err, Boolean(score))
      );
    }, (err, hasTrackedPlayer) => {
      if (err) {
        return cb(err);
      }
      const doLogParse = options.doLogParse;
      const doParse = hasTrackedPlayer || options.forceParse || doLogParse;
      if (doParse) {
        return pQueue.add({
          id: `${moment().format('X')}_${match.match_id}`,
          payload: {
            match_id: match.match_id,
            radiant_win: match.radiant_win,
            start_time: match.start_time,
            duration: match.duration,
            replay_blob_key: match.replay_blob_key,
            pgroup: match.pgroup,
            doLogParse,
          },
        }, {
          lifo: options.lifo,
          attempts: options.attempts || 15,
          backoff: options.backoff || {
            delay: 60 * 1000,
            type: 'exponential',
          },
        })
          .then(parseJob => cb(null, parseJob))
          .catch(cb);
      }
      return cb();
    });
  }
  async.series({
    pp: preprocess,
    dlp: decideLogParse,
    u: upsertMatch,
    uc: upsertMatchCassandra,
    upc: updatePlayerCaches,
    uct: updateCounts,
    cmc: clearMatchCache,
    t: telemetry,
    dm: decideMmr,
    dpro: decideProfile,
    dgcd: decideGcData,
    dmp: decideMetaParse,
    dp: decideReplayParse,
  }, (err, results) =>
    cb(err, results.dp)
  );
}

module.exports = {
  upsert,
  insertPlayer,
  insertMatch,
  insertPlayerRating,
  insertMatchSkill,
  getDistributions,
  getProPlayers,
  getHeroRankings,
  getHeroBenchmarks,
  getMatchBenchmarks,
  getMatchRating,
  getLeaderboard,
  getPlayerMatches,
  getPlayerRatings,
  getPlayerRankings,
  getPlayer,
  getMmrEstimate,
  getMatchesSkill,
  getPeers,
  getProPeers,
};
