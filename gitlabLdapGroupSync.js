var co = require('co');
var every = require('schedule').every;
var ActiveDirectory = require('activedirectory');
var NodeGitlab = require('node-gitlab');

var ACCESS_LEVEL_OWNER = 50;
var ACCESS_LEVEL_MAINTAINER = 40;
var ACCESS_LEVEL_NORMAL = 30;
var ACCESS_LEVEL_REPORTER = 20;
var ACCESS_LEVEL_GUEST = 10;

module.exports = GitlabLdapGroupSync;

var isRunning = false;
var gitlab = undefined;
var ldap = undefined;

function GitlabLdapGroupSync(config) {
  if (!(this instanceof GitlabLdapGroupSync))
    return new GitlabLdapGroupSync(config)
  const ldapConfig = {
    ...config.ldap,
    "attributes": {
      "user": [ "streetAddress", "distinguishedName", "userPrincipalName", "sAMAccountName", "mail", "lockoutTime",
        "whenCreated", "pwdLastSet", "userAccountControl", "employeeID", "sn", "givenName", "initials", "cn",
        "displayName", "comment", "description"]
    }}
  gitlab = NodeGitlab.createThunk(config.gitlab);
  ldap = new ActiveDirectory(ldapConfig);
  this.config = config
}
GitlabLdapGroupSync.prototype.onlyUnique = function (value, index, self) {
  return self.indexOf(value) === index;
}

GitlabLdapGroupSync.prototype.getGroupMembers = function (memberGroups, ldapMembers, groupName) {
  const result = []
  Object.keys(memberGroups)
    .forEach((item) => {
      if (memberGroups[item].gitlab_owner && memberGroups[item].gitlab_owner.includes(groupName)
        || memberGroups[item].gitlab_maintainer && memberGroups[item].gitlab_maintainer.includes(groupName)
        || memberGroups[item].gitlab_guest && memberGroups[item].gitlab_guest.includes(groupName)
        || memberGroups[item].gitlab_reporter && memberGroups[item].gitlab_reporter.includes(groupName)
      ) {
        result.push(Number.parseInt(item));
      }
    })
  ldapMembers
    .forEach((item) => {
      if (!result.includes(item)) {
        result.push(item);
      }
    })

  return result.filter(this.onlyUnique);
}

GitlabLdapGroupSync.prototype.sync = function () {

  if (isRunning) {
    console.log('ignore trigger, a sync is already running');
    return;
  }
  isRunning = true;

  co(function* () {
    // find all users with a ldap identiy
    var gitlabUsers = [];
    var pagedUsers = [];
    var i=0;
    do {
      i++;
      pagedUsers = yield gitlab.users.list({ per_page: 100, page: i });
      gitlabUsers.push.apply(gitlabUsers, pagedUsers);

    } while(pagedUsers.length == 100);

    var gitlabUserMap = {};
    var gitlabLocalUserIds = [];
    for (var user of gitlabUsers) {
      if (user.identities.length > 0) {
        gitlabUserMap[user.email.toLowerCase()] = user.id;
      } else {
        gitlabLocalUserIds.push(user.id);
      }
    }
    console.log(gitlabUserMap);

    //set the gitlab group members based on ldap group
    var gitlabGroups = [];
    var pagedGroups = [];
    var i=0;
    do {
      i++;
      pagedGroups = yield gitlab.groups.list({ per_page: 100, page: i });
      gitlabGroups.push.apply(gitlabGroups, pagedGroups);

    }
    while(pagedGroups.length == 100);
    const membersDefault = yield this.resolveLdapGroupMembers(ldap, 'default', gitlabUserMap);
    let memberGroups;
    const membersMaintainer = yield this.resolveLdapGroupMembers(ldap, this.config['maintainersGroup'] || 'maintainers', gitlabUserMap);
    const membersOwner = yield this.resolveLdapGroupMembers(ldap, this.config['ownersGroup'] || 'admins', gitlabUserMap);
    for (var gitlabGroup of gitlabGroups) {
      console.log('-------------------------');
      console.log('group:', gitlabGroup.name);
      memberGroups = yield this.resolveLdapGroupMembersPermissions(ldap, gitlabGroup.name, gitlabUserMap);

      var gitlabGroupMembers = [];
      var pagedGroupMembers = [];
      var i=0;
      do {
        i++;
        pagedGroupMembers = yield gitlab.groupMembers.list({ id: gitlabGroup.id, per_page: 100, page: i });
        gitlabGroupMembers.push.apply(gitlabGroupMembers, pagedGroupMembers);
      }
      while(pagedGroupMembers.length == 100);

      var currentMemberIds = [];
      for (var member of gitlabGroupMembers) {
        if (gitlabLocalUserIds.indexOf(member.id) > -1) {
          continue; //ignore local users
        }

        var access_level = this.accessLevel(member.id, memberGroups, gitlabGroup.name, membersOwner, membersMaintainer);
        if (access_level && member.access_level !== access_level) {
          console.log('update group member permission', { id: gitlabGroup.id, user_id: member.id, access_level: access_level });
          gitlab.groupMembers.update({ id: gitlabGroup.id, user_id: member.id, access_level: access_level });
        }

        currentMemberIds.push(member.id);
      }
      let ldapGroupMembers = yield this.resolveLdapGroupMembers(ldap, gitlabGroup.name, gitlabUserMap);
      let members = this.getGroupMembers(memberGroups, ldapGroupMembers, gitlabGroup.name );
      members = (members && members.length) ? members : membersDefault;

      //remove unlisted users
      var toDeleteIds = currentMemberIds.filter(x => members.indexOf(x) == -1);
      for (var id of toDeleteIds) {
        console.log('delete group member', { id: gitlabGroup.id, user_id: id });
        gitlab.groupMembers.remove({ id: gitlabGroup.id, user_id: id });
      }

      //add new users
      var toAddIds = members.filter(x => currentMemberIds.indexOf(x) == -1);
      for (var id of toAddIds) {
        var access_level = this.accessLevel(id, memberGroups, gitlabGroup.name, membersOwner, membersMaintainer);
        if (access_level) {
          console.log('add group member', { id: gitlabGroup.id, user_id: id, access_level: access_level });
          gitlab.groupMembers.create({ id: gitlabGroup.id, user_id: id, access_level: access_level });
        }
      }
    }

  }.bind(this)).then(function (value) {
    console.log('sync done');
    isRunning = false;
  }, function (err) {
    console.error(err.stack);
    isRunning = false;
  });
}

var ins = undefined;

GitlabLdapGroupSync.prototype.accessLevel = function (id, memberGroups, groupName, membersOwner, membersMaintainer) {
  const owner = membersOwner.indexOf(id) > -1
  const maintainer = membersMaintainer.indexOf(id) > -1

  if(owner) {
    return this.config['ownerAccessLevel'] || ACCESS_LEVEL_OWNER;
  } else if (maintainer) {
    return this.config['maintainerAccessLevel'] || ACCESS_LEVEL_MAINTAINER;
  }
  const roles = memberGroups[id.toString()]
  if (roles !== undefined) {
    if(roles.gitlab_owner && roles.gitlab_owner.includes(groupName)) {
      return this.config['ownerAccessLevel'] || ACCESS_LEVEL_OWNER;
    } else if (roles.gitlab_maintainer && roles.gitlab_maintainer.includes(groupName)) {
      return this.config['maintainerAccessLevel'] || ACCESS_LEVEL_MAINTAINER;
    } else if (roles.gitlab_reporter && roles.gitlab_reporter.includes(groupName)) {
      return this.config['reporterAccessLevel'] || ACCESS_LEVEL_REPORTER;
    } else if (roles.gitlab_guest && roles.gitlab_guest.includes(groupName)) {
      return this.config['guestAccessLevel'] || ACCESS_LEVEL_GUEST;
    }
    return this.config['defaultAccessLevel'] || ACCESS_LEVEL_NORMAL;
  }
  return undefined;
}

GitlabLdapGroupSync.prototype.startScheduler = function (interval) {
  this.stopScheduler();
  ins = every(interval).do(this.sync.bind(this));
}

GitlabLdapGroupSync.prototype.stopScheduler = function () {
  if (ins) {
    ins.stop();
  }
  ins = undefined;
}

GitlabLdapGroupSync.prototype.resolveLdapGroupMembers = function(ldap, group, gitlabUserMap) {
  var groupName = (this.config['groupPrefix']) + group
  console.log('Loading users for group: ' + groupName)
  return new Promise(function (resolve, reject) {
    var ldapGroups = {};
    ldap.getUsersForGroup(groupName, function (err, users) {
      if (err) {
        reject(err);
        return;
      }

      groupMembers = [];
      if(users) {
        for (var user of users) {
          if (gitlabUserMap[user.userPrincipalName.toLowerCase()]) {
            groupMembers.push(gitlabUserMap[user.userPrincipalName.toLowerCase()]);
          }
        }
      }
      console.log('Members=' + groupMembers);
      resolve(groupMembers);
    });
  });
}

GitlabLdapGroupSync.prototype.resolveLdapGroupMembersPermissions = function(ldap, group, gitlabUserMap) {
  var groupName = (this.config['groupPrefix']) + group
  console.log('Loading users for group: ' + groupName)
  return new Promise(function (resolve, reject) {
    var ldapGroups = {};
    ldap.getUsersForGroup(groupName, function (err, users) {
      if (err) {
        reject(err);
        return;
      }

      const groupMembers = {};
      if(users) {
        for (var user of users) {
          if (gitlabUserMap[user.userPrincipalName.toLowerCase()]) {
            let roles = {
              gitlab_owner: [],
              gitlab_maintainer: [],
              gitlab_reporter: [],
              gitlab_guest: []
            };

            try {
              roles = JSON.parse(user.streetAddress)
              groupMembers[gitlabUserMap[user.userPrincipalName.toLowerCase()]] = roles;
            } catch(error) {
              groupMembers[gitlabUserMap[user.userPrincipalName.toLowerCase()]] = roles;
              console.error('Error during parsing groups', user.streetAddress)
            }
          }
        }
      }
      console.log('Members=' + JSON.stringify(groupMembers));
      resolve(groupMembers);
    });
  });
}
