// Copyright 2019 The Appgineer
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
const STAGING_PUSH_MULTI = 2;
const STAGING_UNSTAGE = 3;
const STAGING_REMOVE = 4;

const output_dir = (process.argv[2] ? process.argv[2] : process.cwd() + '/output');

var RoonApi         = require("node-roon-api"),
    RoonApiSettings = require('node-roon-api-settings'),
    RoonApiStatus   = require('node-roon-api-status');

var core = undefined;
var has_drive;
var drive_props;
var is_configured;
var staging = [];
var current_action = ACTION_IDLE;

var roon = new RoonApi({
    extension_id:        'com.theappgineer.cd-ripper',
    display_name:        'CD Ripper',
    display_version:     '0.1.0',
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://community.roonlabs.com/t/roon-extension-cd-ripper/66590',

    core_paired: function(core_) {
        core = core_;
    },
    core_unpaired: function(core_) {
        core = undefined;
    }
});

var rip_settings = roon.load_config("settings") || {
};

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(rip_settings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            perform_action(l.values);
            delete l.values.action;
            delete l.values.password;
            delete l.values.staging_action;
            delete l.values.staging;

            rip_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", rip_settings);
        }
    },
});

var svc_status = new RoonApiStatus(roon);

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    let global_settings = {
        type: "group",
        title: "Global Settings",
        items: []
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
        } else if (settings.share.indexOf('/') != 0 && settings.share.indexOf('~') != 0) {
            share.error = "Please specify an absolute path or SMB share";
            l.has_error = true;
        }
    }

    l.layout.push(global_settings);

    if (current_action === ACTION_IDLE) {
        // Collect possible actions
        const password = {
            type:    "string",
            title:   "Password (not stored)",
            setting: "password"
        };
        const setup_share = {
            type:  "label",
            title: "Please setup Share in Global Settings"
        };
        let action = {
            type:    "dropdown",
            title:   "Action",
            values:  [{ title: "(select action)", value: ACTION_IDLE }],
            setting: "action"
        };

        if (has_drive) {
            if (is_configured) {
                action.values.push({ title: "Rip", value: ACTION_RIP });
                //action.values.push({ title: "Rip & Push", value: ACTION_RIP_PUSH });
            } else {
                action.values.push({ title: "Configure Drive", value: ACTION_CONFIGURE });
            }
        } else {
            action.values.push({ title: "Scan Drive", value: ACTION_SCAN });
        }

        if (staging.length) {
            action.values.push({ title: "Manage Staging Area", value: ACTION_STAGING });
        }

        // Mode 1: Perform a drive related action
        l.layout.push(action);

        if (settings.action == ACTION_RIP_PUSH) {
            if (settings.share) {
                if (settings.share.indexOf('//') == 0) {
                    // SMB share
                    if (settings.user) {
                        l.layout.push(password);
                    } else {
                        l.layout.push(setup_share);
                    }
                }
            } else {
                l.layout.push(setup_share);
            }

            // No push from staging area
            settings.staging = undefined;
        } else if (settings.action == ACTION_STAGING) {
            // Mode 2: Perform a staging area related action
            let staging_area = {
                type:    "dropdown",
                title:   "Staging Area",
                values:  [{ title: "(select album)", value: undefined }],
                setting: "staging"
            };

            for (let i = 0; i < staging.length; i++) {
                staging_area.values.push({ title: `${staging[i].Artist} - ${staging[i].Title}`, value: i });
            }
            //staging_area.values.push({ title: 'All', value: staging.length });

            l.layout.push(staging_area);

            if (settings.staging !== undefined) {
                l.layout.push({
                    type:    "dropdown",
                    title:   "Staging Action",
                    values:  [
                        { title: "(select staging action)", value: undefined },
                        { title: "Push",                    value: STAGING_PUSH },
                        //{ title: "Push as Multi Disk",      value: STAGING_PUSH_MULTI },
                        //{ title: "Unstage",                 value: STAGING_UNSTAGE },
                        { title: "Remove",                  value: STAGING_REMOVE }
                    ],
                    setting: "staging_action"
                });

                if (settings.action == ACTION_STAGING &&
                    (settings.staging_action == STAGING_PUSH || settings.staging_action == STAGING_PUSH_MULTI)) {
                    if (settings.share) {
                        if (settings.share.indexOf('//') == 0) {
                            // SMB share
                            if (settings.user) {
                                l.layout.push(password);
                            } else {
                                l.layout.push(setup_share);
                            }
                        }
                    } else {
                        l.layout.push(setup_share);
                    }
                }

                if (settings.staging < staging.length) {
                    l.layout.push({
                        type: "group",
                        title: `${staging[settings.staging].Artist.toUpperCase()} - ` +
                               `${staging[settings.staging].Title.toUpperCase()}\n` +
                               staging[settings.staging].tracks.join('\n'),
                        items: []
                    });
                }
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
            configure(set_idle);
            break;
        case ACTION_RIP:
            rip(set_idle);
            break;
        case ACTION_RIP_PUSH:
            // Keep the password for later
            let password = settings.password;

            rip((staging_index) => {
                if (staging_index != undefined) {
                    settings.staging = staging_index;
                    settings.password = password;
                    push(settings, set_idle);
                } else {
                    set_idle();
                }
            });
            break;
        case ACTION_STAGING:
            switch (settings.staging_action) {
                case STAGING_PUSH:
                    if (settings.staging != undefined) {
                        push(settings, set_idle);
                    } else {
                        set_idle();
                    }
                    break;
                case STAGING_PUSH_MULTI:
                    break;
                case STAGING_UNSTAGE:
                    unstage(settings.staging, set_idle);
                    break;
                case STAGING_REMOVE:
                    remove(settings.staging, set_idle);
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

    whipper(['drive', 'analyze'], {
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
                    case 'WARNING':
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
    let first = true;
    let track;
    let metadata;

    svc_status.set_status("CD Ripping in preperation...", false);

    whipper(['--eject', 'never', 'cd', 'rip'], {
        stdout: (data) => {
            const string = data.toString().trim();
            let progress = undefined;

            if (first) {
                first = false;

                metadata = get_metadata(string);

                if (string.includes('is a finished rip')) {
                    set_status('Already staged', false, metadata);

                } else if (metadata) {
                    metadata.tracks = [];
                }
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
                        svc_status.set_status(fields.slice(2).join(':'), true);
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
                        break;
                }
            }
        },
        close: (code) => {
            let staging_index;

            if (code === 0) {
                set_status("Successfully ripped!", false, metadata);

                if (metadata) {
                    staging_index = staging.length;
                    staging.push(metadata);
                }
            }

            cb && cb(staging_index);
        }
    });
}

function create_config_file() {
    const config_file = require('os').homedir() + '/.config/whipper/whipper.conf';
    const fs = require('fs');

    if (!fs.existsSync(config_file)) {
        // TODO: EACCES exception handling
        fs.writeFileSync(config_file, "[whipper.cd.rip]\n" +
                                      "track_template = %%A/%%d/%%t - %%n\n" +
                                      "disc_template  = %%A/%%d/%%A - %%d\n\n");

    }
}

function get_metadata(string) {
    if (string.includes('disc id')) {
        const lines = string.split('\n');
        let metadata = {};
        let state = 0;

        for (let i = 0; i < lines.length; i++) {
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
                        return metadata;
                    } else {
                        const fields = lines[i].split(': ');

                        metadata[fields[0].trim()] = fields[1].trim();
                    }
                    break;
            }
        }
    }

    return undefined;
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

function push(settings, cb) {
    if (settings.share.indexOf('//') == 0) {
        push_remote(settings, cb);
    } else {
        push_local(settings, cb);
    }
}

function push_local(settings, cb) {
    if (settings.share && settings.staging !== undefined) {
        const rcopy = require('recursive-copy');
        const staging_index = settings.staging;
        const options = {
            filter: [
                '**/*.flac',
                '**/*.log'
            ],
            overwrite: true,
            results:   false
        };
        const share = settings.share.replace('~', require('os').homedir());
        let rel_path = '';

        if (settings.staging != staging.length) {
            rel_path = `${staging[settings.staging].Artist}/${staging[settings.staging].Title}`;
        }

        rcopy(`${output_dir}/${rel_path}`, `${share}/${rel_path}`, options, (error) => {
            if (error) {
                console.error('Copy failed: ' + error);
                svc_status.set_status('Copy failed: ' + error, true);
            } else {
                set_status("Successfully pushed!", false);

                // Remove pushed files from staging area
                remove(staging_index);
            }

            cb && cb();
        });
    } else {
        cb && cb();
    }
}

function push_remote(settings, cb) {
    if (settings.share && settings.user && settings.staging !== undefined) {
        const staging_index = settings.staging;
        let command = `lcd "${output_dir}";`;
        let credentials = settings.user;

        if (settings.staging != staging.length) {
            const artist = staging[settings.staging].Artist;
            const album = staging[settings.staging].Title;

            command += `lcd "${artist}/${album}";` +
                       `mkdir "${artist}";cd "${artist}";` +
                       `mkdir "${album}";cd "${album}";`;
        }

        if (settings.password) {
            credentials += `%${settings.password}`;
        }

        command += 'prompt;recurse;mput *.flac;mput *.log';

        // Use '-E' option to get the expected stdout/stderr behavior
        const args = ['-E', '-U', credentials, settings.share, '-c', command];
        const child = require('child_process').spawn('smbclient', args);

        child.stdout.on('data', (data) => {
            const string = data.toString().trim();

            console.log(`stdout: "${string}"`);
            svc_status.set_status(string, false);
        });

        child.stderr.on('data', (data) => {
            const string = data.toString().trim();

            console.log(`stderr: "${string}"`);
            svc_status.set_status(string, true);
        });

        child.on('close', (code) => {
            console.log('smbclient exited with code:', code);

            if (code === 0) {
                set_status("Successfully pushed!", false);

                // Remove pushed files from staging area
                remove(staging_index);
            }

            cb && cb();
        });
    } else {
        cb && cb();
    }
}

function push_multi(settings, cb) {
}

function unstage(staging_index, cb) {
    if (staging_index != undefined) {
        staging.splice(staging_index, 1);
    }

    cb && cb();
}

function remove(staging_index, cb) {
    if (staging_index != undefined) {
        const rimraf = require("rimraf");
        const fs = require("fs");
        let path = output_dir;

        if (staging_index < staging.length) {
            const artist = staging[staging_index].Artist;
            const album = staging[staging_index].Title;

            path += `/${artist}/${album}`;
            console.log(`Deleting path: ${path}`);

            // Delete the files
            rimraf(path, () => {
                // Remove artist directory if empty now
                try {
                    fs.rmdirSync(`${output_dir}/${artist}`);
                } catch (err) {
                    if (err.code !== 'ENOTEMPTY') {
                        throw err;
                    }
                }

                unstage(staging_index, cb);
            });
        } else {
            // TODO: Remove all
        }
    }
}

function init() {
    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);

    staging = read_JSON_file_sync(output_dir + '/staging.json');

    if (staging === undefined) {
        staging = [];
    }

    roon.start_discovery();
    perform_action({ action: ACTION_SCAN });
}

function read_JSON_file_sync(file) {
    const fs = require('fs');
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

function terminate() {
    const fs = require('fs');

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
