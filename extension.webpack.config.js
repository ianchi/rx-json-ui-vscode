/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const withDefaults = require('./shared.webpack.config');
const path = require('path');
var webpack = require('webpack');

const config = withDefaults({
    context: path.join(__dirname),
    entry: {
        extension: './client/src/clientMain.ts',
    },
    output: {
        filename: 'clientMain.js',
        path: path.join(__dirname, 'client', 'dist'),
    },
});
// add plugin, don't replace inherited
config.plugins.push(new webpack.IgnorePlugin(/vertx/)); // request-light dependency

module.exports = config;
