// Copyright 2019, 2020 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

const ACTION_IDLE = undefined;
const ACTION_SCAN = 1;
const ACTION_CONFIGURE = 2;
const ACTION_RIP = 3;
const ACTION_RIP_PUSH = 4;
const ACTION_STAGING = 5;

const STAGING_PUSH = 1;
const STAGING_CONVERT_MULTI = 2;
const STAGING_APPEND_MULTI = 3;
const STAGING_UNSTAGE = 4;
const STAGING_REMOVE = 5;

const MON_INACTIVE     = 1;
const MON_ACTIVE       = 2;
const MON_FILE_CHANGED = 3;

const credentials_file = require('os').homedir() + '/.config/whipper/.smb';
const output_dir = (process.argv[2] ? process.argv[2] : process.cwd() + '/output');

const fs              = require('fs'),
      RoonApi         = require('node-roon-api'),
      RoonApiSettings = require('node-roon-api-settings'),
      RoonApiStatus   = require('node-roon-api-status');

var has_drive;
var drive_props;
var is_configured;
var staging = {};
var current_action = ACTION_IDLE;
var smb_password = '';

var roon = new RoonApi({
    extension_id:        'com.theappgineer.cd-ripper',
    display_name:        'CD Ripper',
    display_version:     '0.4.0',
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://community.roonlabs.com/t/roon-extension-cd-ripper/66590',

    core_found: function(core) {
        console.log('Core found:', core.display_name);
    },
    core_lost: function(core) {
        console.log('Core lost:', core.display_name);
    }
});

var rip_settings = roon.load_config("settings") || {
};

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        get_credentials(rip_settings, (settings) => {
            cb(makelayout(settings));
        });
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);

        hide_password(l.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            store_credentials(l.values);
            perform_action(l.values);

            if (l.values.action != ACTION_STAGING ||
                (l.values.staging_action != STAGING_CONVERT_MULTI &&
                 l.values.staging_action != STAGING_APPEND_MULTI)) {
                delete l.values.action;
            }
            delete l.values.staging_action;
            delete l.values.staging_key;

            rip_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", rip_settings);
        }
    }
});

var svc_status = new RoonApiStatus(roon);

function get_credentials(settings, cb) {
    fs.readFile(credentials_file, (err, data) => {
        let new_settings = {};

        // Copy settings
        for (const key in settings) {
            new_settings[key] = settings[key];
        }

        new_settings.user = '';
        new_settings.password = '';

        if (!err && data.length) {
            const credentials = data.toString().split('\n');
            const user = credentials[0].split('=')[1].trim();

            // Add credentials
            new_settings.user = user;

            if (credentials.length > 1) {
                const password = credentials[1].split('=')[1].trim();

                for (let i = 0; i < password.length; i++) {
                    new_settings.password += '\u2022';
                }
            }
        }

        cb && cb(new_settings);
    });
}

function store_credentials(settings) {
    let credentials = '';

    if (settings.user) {
        credentials += `username = ${settings.user}`

        if (smb_password) {
            credentials +=`\npassword = ${smb_password}`;
            smb_password = '';

            fs.writeFileSync(credentials_file, credentials, { mode: 0o600 });
        } else if (!settings.password) {
            fs.writeFileSync(credentials_file, credentials, { mode: 0o600 });
        }
    } else {
        fs.writeFileSync(credentials_file, credentials, { mode: 0o600 });
    }

    delete settings.user;
    delete settings.password;
}

function hide_password(settings) {
    const password = settings.password.replace(/\u2022/g, '');

    if (password) {
        smb_password = password;
        settings.password = '';

        for (let i = 0; i < password.length; i++) {
            settings.password += '\u2022';
        }
    }
}

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    let global_settings = {
        type:        "group",
        title:       "Global Settings",
        collapsable: true,
        items:       []
    };
    let share = {
        type:    "string",
        title:   "Share",
        setting: "share"
    };

    global_settings.items.push(share);

    if (settings.share) {
        if (settings.share.indexOf('//') == 0) {
            global_settings.items.push({
                type:    "string",
                title:   "User Name",
                setting: "user"
            });
            global_settings.items.push({
                type:    "string",
                title:   "Password",
                setting: "password"
            });
        } else if (settings.share.indexOf('/') != 0 && settings.share.indexOf('~') != 0) {
            share.error = "Please specify an absolute path or SMB share";
            l.has_error = true;
        }
    }

    if (settings.autorip !== undefined) {
        global_settings.items.push({
            type:    "dropdown",
            title:   "Auto Rip",
            values:  [
                { title: "Disabled", value: false },
                { title: "Enabled",  value: true  }
            ],
            setting: "autorip"
        });
    }

    l.layout.push(global_settings);

    if (current_action === ACTION_IDLE) {
        let setup_share = {
            type:  "group",
            title: "Please verify Global Settings",
            items: []
        };
        let action = {
            type:    "dropdown",
            title:   "Action",
            values:  [{ title: "(select action)", value: ACTION_IDLE }],
            setting: "action"
        };

        // Collect possible actions
        if (has_drive) {
            if (is_configured) {
                action.values.push({ title: "Rip", value: ACTION_RIP });
                action.values.push({ title: "Rip & Push", value: ACTION_RIP_PUSH });
            } else {
                action.values.push({ title: "Configure Drive", value: ACTION_CONFIGURE });
            }
        } else {
            action.values.push({ title: "Scan Drive", value: ACTION_SCAN });
        }

        if (Object.keys(staging).length) {
            action.values.push({ title: "Manage Staging Area", value: ACTION_STAGING });
        }

        // Mode 1: Perform a drive related action
        l.layout.push(action);

        if (settings.action == ACTION_RIP_PUSH) {
            if (settings.share) {
                if (settings.share.indexOf('//') == 0) {
                    // SMB share
                    if (!settings.user) {
                        setup_share.title += ', no credentials set'
                        l.layout.push(setup_share);
                    }
                }
            } else {
                setup_share.title += ', no Share set'
                share.error = "Please specify an absolute path or SMB share";
                l.layout.push(setup_share);
                l.has_error = true;
            }

            // No push from staging area
            settings.staging_key = undefined;
        } else if (settings.action == ACTION_STAGING) {
            // Mode 2: Perform a staging area related action
            let staging_area = {
                type:    "dropdown",
                title:   "Staging Area",
                values:  [{ title: "(select album)", value: undefined }],
                setting: "staging_key"
            };

            for (const key in staging) {
                staging_area.values.push({ title: `${staging[key].Artist} - ${key}`, value: key });
            }

            l.layout.push(staging_area);

            if (settings.staging_key != undefined && staging[settings.staging_key]) {
                let staging_actions = {
                    type:    "dropdown",
                    title:   "Staging Action",
                    values:  [
                        { title: "(select staging action)", value: undefined },
                        { title: "Push",                    value: STAGING_PUSH },
                        //{ title: "Unstage",                 value: STAGING_UNSTAGE },
                        { title: "Remove",                  value: STAGING_REMOVE }
                    ],
                    setting: "staging_action"
                };

                if (Object.keys(staging).length > 1) {
                    if (settings.multi_disk_count) {
                        if (staging[settings.staging_key].fs_album != settings.multi_disk_title) {
                            staging_actions.values.splice(1, 0, {
                                title: `Append to "${settings.multi_disk_title}"`,
                                value: STAGING_APPEND_MULTI
                            });
                        }
                    } else {
                        staging_actions.values.splice(1, 0, {
                            title: "Convert to Multi Disk",
                            value: STAGING_CONVERT_MULTI
                        });
                    }
                }

                l.layout.push(staging_actions);

                if (settings.action == ACTION_STAGING) {
                    switch (settings.staging_action) {
                        case STAGING_PUSH:
                            if (settings.share) {
                                if (settings.share.indexOf('//') == 0) {
                                    // SMB share
                                    if (!settings.user) {
                                        setup_share.title += ', no credentials set'
                                        l.layout.push(setup_share);
                                    }
                                }
                            } else {
                                setup_share.title += ', no Share set'
                                share.error = "Please specify an absolute path or SMB share";
                                l.layout.push(setup_share);
                                l.has_error = true;
                            }
                            break;
                        case STAGING_CONVERT_MULTI:
                            const title = {
                                type:    "string",
                                title:   "Multi Disk Title",
                                setting: "multi_disk_title"
                            };

                            if (settings.staging_key) {
                                if (!settings.multi_disk_title) {
                                    settings.multi_disk_title = decode_unicode(staging[settings.staging_key].fs_album);
                                }

                                l.layout.push(title);

                                if (settings.multi_disk_title == decode_unicode(staging[settings.staging_key].fs_album)) {
                                    title.error = 'Multi Disk Title should differ from original title';
                                    l.has_error = true;
                                }
                            }

                            break;
                        default:
                            break;
                    }
                }

                l.layout.push({
                    type:  "group",
                    title: `${staging[settings.staging_key].Artist.toUpperCase()} - ` +
                           `${staging[settings.staging_key].Title.toUpperCase()}\n` +
                           staging[settings.staging_key].tracks.join('\n'),
                    items: []
                });
            }
        }
    } else {
        l.layout.push({
            type: "group",
            title: "There is currently an action in progress, please try again later",
            items: []
        });
    }

    return l;
}

function perform_action(settings) {
    current_action = settings.action;

    switch (current_action) {
        case ACTION_SCAN:
            scan(set_idle);
            break;
        case ACTION_CONFIGURE:
            configure(eject);
            break;
        case ACTION_RIP:
            rip(eject);
            break;
        case ACTION_RIP_PUSH:
            rip((staging_key) => {
                push(staging_key, settings, eject);
            });
            break;
        case ACTION_STAGING:
            switch (settings.staging_action) {
                case STAGING_PUSH:
                    push(settings.staging_key, settings, set_idle);
                    break;
                case STAGING_CONVERT_MULTI:
                    settings.multi_disk_count = 1;
                    convert(settings.staging_key, settings, set_idle);
                    break;
                case STAGING_APPEND_MULTI:
                    settings.multi_disk_count++;
                    append(settings.staging_key, settings, set_idle);
                    break;
                case STAGING_UNSTAGE:
                    unstage(settings.staging_key, set_idle);
                    break;
                case STAGING_REMOVE:
                    remove(settings.staging_key, settings, set_idle);
                    break;
                default:
                    set_idle();
                    break;
            }
            break;
        default:
            break;
    }
}

function set_idle() {
    current_action = ACTION_IDLE;
}

function scan(cb) {
    has_drive = undefined;
    is_configured = undefined;

    svc_status.set_status("Drive scanning in progress...", false);

    whipper(['drive', 'list'], {
        stdout: (data) => {
            const fields = data.toString().split('\n')[0].split(', ');
            drive_props = {};

            for (let i = 0; i < fields.length; i++) {
                const key_value = fields[i].trim().split(': ');

                drive_props[key_value[0]] = key_value[1];
            }

            console.log(drive_props);
        },
        stderr: (data) => {
            const lines = data.toString().trim().split('\n');

            for (let i = 0; i < lines.length; i++) {
                const fields = lines[i].split(':');

                switch (fields[0]) {
                    case 'CRITICAL':
                        has_drive = false;
                        is_configured = false;
                        svc_status.set_status("No drive found!", true);
                        break;
                    case 'WARNING':
                        has_drive = true;
                        is_configured = false;
                        svc_status.set_status("Please configure drive", true);
                        break;
                }
            }
        },
        close: (code) => {
            if (code === 0 && is_configured === undefined) {
                svc_status.set_status(`Drive found:\n${drive_props.vendor} ` +
                                      `${drive_props.model} ${drive_props.release}`, false);
                has_drive = true;
                is_configured = true;
            }

            cb && cb();
        }
    });
}

function configure(cb) {
    is_configured = undefined;

    svc_status.set_status("Drive configuration in progress...", false);

    create_config_file();

    whipper(['--eject', 'never', 'drive', 'analyze'], {
        stdout: (data) => {
            if (is_configured === undefined) {
                const string = data.toString().trim();

                string.length && svc_status.set_status(string, false);
            }
        },
        stderr: (data) => {
            const lines = data.toString().trim().split('\n');

            for (let i = 0; i < lines.length; i++) {
                const fields = lines[i].split(':');

                switch (fields[0]) {
                    case 'CRITICAL':
                        is_configured = false;
                        svc_status.set_status("Please insert a CD and restart drive configuration", true);
                        break;
                }
            }
        },
        close: (code) => {
            if (code === 0 && is_configured === undefined) {
                whipper(['offset', 'find'], {
                    stdout: (data) => {
                        if (is_configured === undefined) {
                            const string = data.toString().trim();

                            string.length && svc_status.set_status(string, false);
                        }
                    },
                    stderr: (data) => {
                        const lines = data.toString().trim().split('\n');

                        for (let i = 0; i < lines.length; i++) {
                            const fields = lines[i].split(':');

                            switch (fields[0]) {
                                case 'ERROR':
                                    is_configured = false;
                                    svc_status.set_status("Drive offset can't be determined, " +
                                                          "try another disc", true);
                                    break;
                            }
                        }
                    },
                    close: (code) => {
                        if (code === 0 && is_configured === undefined) {
                            is_configured = true;
                            svc_status.set_status("Drive configuration successful!", false);
                        }

                        cb && cb();
                    }
                });
            } else {
                cb && cb();
            }
        }
    });
}

function rip(cb) {
    let track;
    let metadata = {};
    let staging_key;

    svc_status.set_status("CD Ripping in preparation...", false);

    whipper(['--eject', 'never', 'cd', 'rip'], {
        stdout: (data) => {
            const string = data.toString().trim();
            let progress = undefined;

            if (Object.keys(metadata).length == 0) {
                get_metadata(string, metadata);
            } else if (string.includes(' ... ')) {
                progress = string.split(' ... ');

                progress = (progress.length > 1 ? progress[1] : undefined);
            } else if (string.includes('rip accurate')) {
                const lines = string.split('\n');

                if (track) {
                    // Store track
                    metadata.tracks.push(track);
                }

                for (let i = 0; i < lines.length; i++) {
                    const confidence = lines[i].split('(')[1].split(')')[0];

                    if (metadata && i < metadata.tracks.length) {
                        metadata.tracks[i] += ` (${confidence})`;
                    }
                }
            }

            if (string.includes('is a finished rip')) {
                set_status('Already staged', false, metadata);

                if (staging[metadata.Title]) {
                    staging_key = metadata.Title;
                }
            }

            if (track && progress) {
                set_status(`${track} (${progress})`, false, metadata);
            }
        },
        stderr: (data) => {
            const lines = data.toString().trim().split('\n');

            for (let i = 0; i < lines.length; i++) {
                const fields = lines[i].split(':');

                switch (fields[0]) {
                    case 'CRITICAL':
                        svc_status.set_status("Please insert a CD and retry", true);
                        break;
                    case 'INFO':
                        if (fields[2].includes('ripping track ')) {
                            if (fields.length > 3) {
                                if (metadata && track) {
                                    // Store previous track
                                    metadata.tracks.push(track);
                                }

                                track = fields[3].trim();
                            } else {
                                track = undefined;
                            }
                        }

                        if (metadata && fields[2].includes('parsing .cue file')) {
                            const separator = fields[2].charAt(fields[2].length - 1);
                            
                            // Get the relative output path from the INFO string
                            // It is needed because it has special characters replaced
                            const path = fields[2].split(separator)[1].split('/');

                            metadata.fs_artist = path[0];
                            metadata.fs_album = path[1];
                        }
                        break;
                }
            }
        },
        close: (code) => {
            if (metadata) {
                if (code === 0) {
                    set_status("Successfully ripped!", false, metadata);

                    staging_key = metadata.Title;
                    staging[staging_key] = metadata;
                } else {
                    // TODO: Cleanup a partial rip
                }
            }

            cb && cb(staging_key);
        }
    });
}

function eject() {
    const execFile = require('child_process').execFile;

    // The eject application by Jeff Tranter requires an unlock of the device button before the eject
    execFile('eject', ['-i', 'off'], () => {
        execFile('eject', ['-r'], set_idle);
    });
}

function create_config_file() {
    const config_file = require('os').homedir() + '/.config/whipper/whipper.conf';

    if (!fs.existsSync(config_file)) {
        // TODO: EACCES exception handling
        fs.writeFileSync(config_file, "[whipper.cd.rip]\n" +
                                      "track_template = %%A/%%d/%%t - %%n\n" +
                                      "disc_template  = %%A/%%d/%%A - %%d\n\n");

    }
}

function get_metadata(string, metadata) {
    if (string.includes('disc id')) {
        const lines = string.split('\n');

        for (let i = 0, state = 0; i < lines.length && state < 3; i++) {
            switch (state) {
                case 0:
                    if (lines[i] == 'Matching releases:') {
                        state = 1;
                    }
                    break;
                case 1:
                    if (lines[i] == '') {
                        state = 2;
                    }
                    break;
                case 2:
                    if (lines[i] == '') {
                        metadata.tracks = [];
                        state = 3;
                    } else {
                        const fields = lines[i].split(': ');

                        metadata[fields[0].trim()] = fields[1].trim();
                    }
                    break;
            }
        }
    }
}

function set_status(string, error, metadata) {
    if ((current_action == ACTION_RIP || current_action == ACTION_RIP_PUSH) && metadata) {
        string = `${metadata.Type}: ${metadata.Artist} - ${metadata.Title}\n${string}`;
    }

    svc_status.set_status(string, error);
}

function whipper(user_args, cbs) {
    const spawn = require('child_process').spawn;
    const child = spawn('whipper', user_args, { cwd: output_dir });

    child.stdout.on('data', (data) => {
        console.log('stdout: "' + data.toString().trim() + '"');

        cbs && cbs.stdout && cbs.stdout(data);
    });

    child.stderr.on('data', (data) => {
        console.log('stderr: "' + data.toString().trim() + '"');

        cbs && cbs.stderr && cbs.stderr(data);
    });

    child.on('close', (code) => {
        console.log('whipper exited with code:', code);

        cbs && cbs.close && cbs.close(code);
    });
}

function push(staging_key, settings, cb) {
    if (staging_key != undefined) {
        set_status(`Pushing "${staging[staging_key].Artist} - ${staging[staging_key].Title}"\u2026`, false);

        if (staging_key == settings.multi_disk_title) {
            delete settings.multi_disk_title;
            delete settings.multi_disk_count;
        }

        remove_hidden_track(staging_key);

        if (settings.share.indexOf('//') == 0) {
            push_remote(staging_key, settings, cb);
        } else {
            push_local(staging_key, settings, cb);
        }
    } else {
        cb && cb();
    }
}

function remove_hidden_track(staging_key) {
    const regex = /^00 - .+[.]flac$/;
    let artist;
    let album;

    if (staging[staging_key].fs_artist) {
        artist = decode_unicode(staging[staging_key].fs_artist);
        album = decode_unicode(staging[staging_key].fs_album);
    } else {
        artist = staging[staging_key].Artist;
        album = staging[staging_key].Title;
    }

    const path = `${output_dir}/${artist}/${album}/`;

    fs.readdirSync(path)
    .filter(f => regex.test(f))
    .map(f => {
        console.log('Removing hidden track:', path + f);
        staging[staging_key].tracks.shift();
        fs.unlinkSync(path + f);
    });
}

function push_local(staging_key, settings, cb) {
    if (settings.share && staging_key !== undefined) {
        const mkdirp = require('mkdirp');
        const share = settings.share.replace('~', require('os').homedir());
        let rel_path = '';

        if (staging_key) {
            let artist;
            let album;

            if (staging[staging_key].fs_artist) {
                artist = decode_unicode(staging[staging_key].fs_artist);
                album = decode_unicode(staging[staging_key].fs_album);
            } else {
                artist = staging[staging_key].Artist;
                album = staging[staging_key].Title;
            }

            rel_path = `${artist}/${album}`;
        }

        mkdirp(`${share}/${rel_path}`).then((made) => {
            const rcopy = require('recursive-copy');
            const options = {
                filter: [
                    '**/*.flac',
                    '**/*.log'
                ],
                overwrite:   true,
                results:     false,
                concurrency: 4
            };
            const copy = rcopy(`${output_dir}/${rel_path}`, `${share}/${rel_path}`, options);

            copy.on(rcopy.events.COPY_FILE_START, (operation) => {
                set_status('Copying file: ' + operation.src + '...');
            });

            copy.on(rcopy.events.COPY_FILE_COMPLETE, (operation) => {
                set_status('Copied file: ' + operation.src);
            });

            copy.on(rcopy.events.COMPLETE, () => {
                const rchown = require('chownr');
                const stats = fs.statSync(share);
                const top_dir = (made ? made : `${share}/${rel_path}`);

                set_status("Changing file ownership...", false);

                // Use UID/GID of stats and change the ownership of the pushed files
                rchown(top_dir, stats.uid, stats.gid, (err) => {
                    if (err) {
                        console.error(err);
                    }

                    set_status("Successfully pushed!", false);

                    cb && cb();
                });

                // Remove pushed files from staging area
                remove(staging_key, settings);
            });

            copy.on(rcopy.events.ERROR, (error) => {
                if (error) {
                    const split = error.toString().split(': ');

                    if (split.length > 1 && split[1] == 'ENOENT') {
                        set_status("Album not found!\nStaging Area updated", true);

                        // Remove pushed files from staging area
                        remove(staging_key, settings);
                    } else {
                        console.error('Copy failed: ' + error);
                        svc_status.set_status('Copy failed: ' + error, true);
                    }
                }

                cb && cb();
            });

            copy.catch((err) => {
                console.error(err);

                if (err.code == 'ENOENT') {
                    svc_status.set_status('No such file or directory:\n' + err.path, true);
                }

                cb && cb();
            });
        });
    } else {
        cb && cb();
    }
}

function push_remote(staging_key, settings, cb) {
    if (settings.share && staging_key !== undefined) {
        const share_fields = settings.share.split('/');
        const no_of_slashes_till_path_slice = 4;    // Including slash of path slice
        const share = share_fields.slice(0, no_of_slashes_till_path_slice).join('/');
        let command = `lcd "${output_dir}";`;

        if (share_fields.length > no_of_slashes_till_path_slice) {
            const path = share_fields.slice(no_of_slashes_till_path_slice).join('/');

            command += `cd "${path}";`;
        }

        if (staging_key) {
            let artist;
            let album;

            if (staging[staging_key].fs_artist) {
                artist = decode_unicode(staging[staging_key].fs_artist);
                album = decode_unicode(staging[staging_key].fs_album);
            } else {
                artist = staging[staging_key].Artist;
                album = staging[staging_key].Title;
            }

            command += `lcd "${artist}/${album}";` +
                       `mkdir "${artist}";cd "${artist}";` +
                       `mkdir "${album}";cd "${album}";`;
        }

        command += 'prompt;recurse;mput *.flac;mput *.log';
        console.log(share, command);

        // Use '-E' option to get the expected stdout/stderr behavior
        const args = ['-N', '-E', '-A', credentials_file, share, '-c', command];
        const child = require('child_process').spawn('smbclient', args);
        let error = false;

        child.stdout.on('data', (data) => {
            const string = data.toString().trim();

            console.log(`stdout: "${string}"`);
            svc_status.set_status(string, false);
        });

        child.stderr.on('data', (data) => {
            const string = data.toString().trim();

            if (!error) {
                if (string.includes('NT_STATUS_UNSUCCESSFUL') ||
                    string.includes('NT_STATUS_OBJECT_PATH_NOT_FOUND') ||
                    string.includes('NT_STATUS_BAD_NETWORK_NAME') ||
                    string.includes('NT_STATUS_LOGON_FAILURE')) {
                    error = true;
                }

                console.log(`stderr: "${string}"`);
                svc_status.set_status(string, error);
            }
        });

        child.on('close', (code) => {
            console.log('smbclient exited with code:', code);

            // Return code 0 doesn't necessarily mean success :(
            if (!error && code === 0) {
                set_status("Successfully pushed!", false);

                // Remove pushed files from staging area
                remove(staging_key, settings);
            }

            cb && cb();
        });
    } else {
        cb && cb();
    }
}

function convert(staging_key, settings, cb) {
    let multi_disk = {};

    // Copy fields
    for (const key in staging[staging_key]) {
        if (key != 'tracks' && key != 'Duration') {
            multi_disk[key] = staging[staging_key][key];
        }
    }

    // Update fields
    multi_disk.Title = settings.multi_disk_title;
    multi_disk.fs_album = settings.multi_disk_title;
    multi_disk.tracks = [];
    staging[settings.multi_disk_title] = multi_disk;

    move_to_multi_disk(staging_key, settings, multi_disk, () => {
        svc_status.set_status(`Multi Disk album "${multi_disk.Title}" created`, false);

        cb && cb();
    });
}

function append(staging_key, settings, cb) {
    move_to_multi_disk(staging_key, settings, staging[settings.multi_disk_title], () => {
        svc_status.set_status(`Multi Disk album "${settings.multi_disk_title}" extended`, false);

        cb && cb();
    });
}

function move_to_multi_disk(staging_key, settings, multi_disk, cb) {
    const mkdirp = require('mkdirp');
    const artist_dir = `${output_dir}/${decode_unicode(multi_disk.fs_artist)}`;
    const dest_dir = `${artist_dir}/${decode_unicode(multi_disk.fs_album)}/`;

    // Copy files
    mkdirp(dest_dir)
    .then((made) => {
        const src_dir = `${artist_dir}/${decode_unicode(staging[staging_key].fs_album)}/`;

        move_track(staging[staging_key].tracks,
                   settings.multi_disk_count,
                   0,
                   src_dir,
                   dest_dir,
                   (err, track_name, done) => {
            if (err) {
                svc_status.set_status(err, true);

                cb && cb();
            } else {
                if (track_name) {
                    multi_disk.tracks.push(track_name);
                }

                if (done) {
                    console.log(multi_disk);

                    // Move log file
                    const file = `${decode_unicode(staging[staging_key].fs_artist)} - ` +
                                 `${decode_unicode(staging[staging_key].fs_album)}.log`;

                    fs.rename(src_dir + file, dest_dir + file, (err) => {
                        remove(staging_key, settings, cb);
                    });
                }
            }
        });
    })
    .catch((err) => {
        cb && cb();
    });
}

function move_track(tracks, disk_index, track_index, src_dir, dest_dir, cb) {
    const src_file = `${tracks[track_index].split('.flac')[0]}.flac`;
    const track_name = `0${disk_index}-${tracks[track_index]}`;
    const dest_file = `${track_name.split('.flac')[0]}.flac`;

    fs.rename(src_dir + src_file, dest_dir + dest_file, (err) => {
        if (track_index + 1 === tracks.length) {
            cb(err, track_name, true);
        } else {
            cb(err, track_name, false);

            if (!err) {
                move_track(tracks, disk_index, track_index + 1, src_dir, dest_dir, cb);
            }
        }
    });
}

function unstage(staging_key, cb) {
    if (staging_key != undefined) {
        delete staging[staging_key];
    }

    cb && cb();
}

function remove(staging_key, settings, cb) {
    if (staging_key != undefined) {
        const rimraf = require('rimraf');
        let artist;
        let album;
        let path = output_dir;

        if (staging_key == settings.multi_disk_title) {
            delete settings.multi_disk_title;
            delete settings.multi_disk_count;
        }

        if (staging[staging_key].fs_artist) {
            artist = decode_unicode(staging[staging_key].fs_artist);
            album = decode_unicode(staging[staging_key].fs_album);
        } else {
            artist = staging[staging_key].Artist;
            album = staging[staging_key].Title;
        }

        path += `/${artist}/${album}`;
        console.log(`Deleting path: ${path}`);

        // Delete the files
        rimraf(path, (err) => {
            if (err) {
                console.error(err);
            }

            // Remove artist directory if empty now
            try {
                fs.rmdirSync(`${output_dir}/${artist}`);
            } catch (err) {
                if (err.code != 'ENOTEMPTY' && err.code != 'ENOENT') {
                    throw err;
                }
            }

            unstage(staging_key, cb);
        });
    }
}

function decode_unicode(unicode_string) {
    let result = unicode_string;

    result = result.replace(/\\u([0-9a-fA-F]{4})/g, (m, cc) => String.fromCharCode("0x" + cc));
    result = result.replace(/\\x([0-9a-fA-F]{2})/g, (m, cc) => String.fromCharCode("0x00" + cc));

    return result;
}

function init() {
    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);

    staging = read_JSON_file_sync(output_dir + '/staging.json');

    if (staging === undefined) {
        staging = {};
    } else if (staging instanceof Array) {
        // Convert from the old Array layout to the Object layout
        let staging_object = {};

        for (let i = 0; i < staging.length; i++) {
            const key = staging[i].Title;

            staging_object[key] = staging[i];
        }

        staging = staging_object;
    }

    monitor_file(`${require('os').homedir()}/inserted`, (state) => {
        switch (state) {
            case MON_INACTIVE:
                console.log(`Disk monitoring inactive`);
                break;
            case MON_ACTIVE:
                console.log(`Disk monitoring active`);
                break;
            case MON_FILE_CHANGED:
                console.log(`Disk inserted`);

                if (rip_settings.autorip === undefined) {
                    rip_settings.autorip = false;
                    roon.save_config("settings", rip_settings);
                } else if (rip_settings.autorip && is_configured) {
                    current_action = ACTION_RIP_PUSH;

                    rip((staging_key) => {
                        push(staging_key, rip_settings, eject);
                    });
                }
                break;
        }
    });

    roon.start_discovery();
    perform_action({ action: ACTION_SCAN });
}

function read_JSON_file_sync(file) {
    let parsed = undefined;

    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }

    return parsed;
}

function monitor_file(file, cb) {
    // Check if the file is readable.
    fs.access(file, fs.constants.R_OK, (err) => {
        cb && cb(err ? MON_INACTIVE : MON_ACTIVE);

        if (!err) {
            fs.watch(file, (eventType) => {
                // Get the size from the file stats and only report change if it has actual content
                fs.stat(file, (err, stats) => {
                    cb && cb(err ? MON_INACTIVE : (stats.size ? MON_FILE_CHANGED : MON_ACTIVE));
                });
            });
        }
    });
}

function terminate() {
    if (staging) {
        fs.writeFileSync(output_dir + '/staging.json', JSON.stringify(staging));
    }

    process.exit(0);
}

roon.init_services({
    required_services:   [ ],
    provided_services:   [ svc_settings, svc_status ]
});

init();
