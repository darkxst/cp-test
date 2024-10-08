import { __decorate } from "tslib";
import { LitElement, html, css } from 'lit';
import { customElement, state, property, query } from 'lit/decorators.js';
import '@material/mwc-button';
import '@material/mwc-icon-button';
import '@material/mwc-linear-progress';
import '@material/mwc-circular-progress';
import '@material/mwc-formfield';
import '@material/mwc-radio';
import '@material/mwc-dialog';
import { mdiChip, mdiShimmer, mdiAutorenew, mdiClose, mdiAlert } from '@mdi/js';
import './usf-icon';
import './usf-icon-button';
import './usf-file-upload';
import { parseFirmwareBuffer } from './firmware-selector';
import './firmware-selector';
import { FirmwareNames, ApplicationNames, ApplicationTypeToFirmwareType, mdiFirmware, } from './const';
import { setupPyodide, PyodideLoadState } from './setup-pyodide';
import { downloadFile } from './utils';
var UploadProgressState;
(function (UploadProgressState) {
    UploadProgressState[UploadProgressState["IDLE"] = 0] = "IDLE";
    UploadProgressState[UploadProgressState["CONNECTING"] = 1] = "CONNECTING";
    UploadProgressState[UploadProgressState["FLASHING"] = 2] = "FLASHING";
})(UploadProgressState || (UploadProgressState = {}));
var FlashingStep;
(function (FlashingStep) {
    FlashingStep[FlashingStep["IDLE"] = 0] = "IDLE";
    FlashingStep[FlashingStep["SELECTING_PORT"] = 1] = "SELECTING_PORT";
    FlashingStep[FlashingStep["PORT_SELECTION_CANCELLED"] = 2] = "PORT_SELECTION_CANCELLED";
    FlashingStep[FlashingStep["LOADING_PYODIDE"] = 3] = "LOADING_PYODIDE";
    FlashingStep[FlashingStep["PROBING"] = 4] = "PROBING";
    FlashingStep[FlashingStep["PROBING_COMPLETE"] = 5] = "PROBING_COMPLETE";
    FlashingStep[FlashingStep["PROBING_FAILED"] = 6] = "PROBING_FAILED";
    FlashingStep[FlashingStep["SELECT_FIRMWARE"] = 7] = "SELECT_FIRMWARE";
    FlashingStep[FlashingStep["INSTALLING"] = 8] = "INSTALLING";
    FlashingStep[FlashingStep["INSTALL_FAILED"] = 9] = "INSTALL_FAILED";
    FlashingStep[FlashingStep["DONE"] = 10] = "DONE";
})(FlashingStep || (FlashingStep = {}));
let FlashingDialog = class FlashingDialog extends LitElement {
    constructor() {
        super(...arguments);
        this.flashingStep = FlashingStep.IDLE;
        this.pyodideLoadState = PyodideLoadState.LOADING_PYODIDE;
        this.debugLog = '';
        this.uploadProgress = 0;
        this.progressState = UploadProgressState.IDLE;
    }
    firstUpdated(changedProperties) {
        super.firstUpdated(changedProperties);
        this.mwcDialog.addEventListener('close', this.close);
        this.selectSerialPort();
    }
    getFirmwareMetadata() {
        if (!this.selectedFirmware) {
            return html ``;
        }
        let metadata;
        try {
            metadata = this.selectedFirmware.get_nabucasa_metadata();
        }
        catch (e) {
            return html ``;
        }
        return html `
      <table>
        <tbody>
          <tr>
            <th>Type</th>
            <td>
              ${FirmwareNames[metadata.fw_type.value] ||
            'unknown'}
            </td>
          </tr>
          <tr>
            <th>SDK Version</th>
            <td>${this.simpleVersion(metadata.sdk_version)}</td>
          </tr>
          <tr>
            <th>EZSP Version</th>
            <td>${this.simpleVersion(metadata.ezsp_version) || '-'}</td>
          </tr>
        </tbody>
      </table>
    `;
    }
    async selectSerialPort() {
        this.flashingStep = FlashingStep.SELECTING_PORT;
        const options = {};
        if (this.manifest.usb_filters) {
            options.filters = this.manifest.usb_filters.map(f => ({
                usbProductId: f.pid,
                usbVendorId: f.vid,
            }));
        }
        try {
            this.serialPort = await navigator.serial.requestPort(options);
        }
        catch (err) {
            console.log(err);
            this.mwcDialog.open = true;
            this.serialPort = undefined;
            this.flashingStep = FlashingStep.PORT_SELECTION_CANCELLED;
            return;
        }
        this.mwcDialog.open = true;
        this.flashingStep = FlashingStep.LOADING_PYODIDE;
        this.pyodide = await setupPyodide(newLoadState => {
            this.pyodideLoadState = newLoadState;
        });
        await this.onPyodideLoaded();
    }
    async onPyodideLoaded() {
        this.pyodide.setStdout({
            batched: (msg) => {
                console.log(msg);
                this.debugLog += `${msg}\n`;
            },
        });
        this.pyodide.setStderr({
            batched: (msg) => {
                console.warn(msg);
                this.debugLog += `${msg}\n`;
            },
        });
        // Set up the flasher
        this.pyodide
            .pyimport('webserial_transport')
            .set_global_serial_port(this.serialPort);
        const PyApplicationType = this.pyodide.pyimport('universal_silabs_flasher.const').ApplicationType;
        // Pyodide currently seems to have issues passing double proxied objects, especially
        // with list comprehensions and generators. Until this is fixed, we need to
        // explicitly convert the types with a wrapper function.
        this.pyFlasher = this.pyodide
            .runPython(`
      from universal_silabs_flasher.flasher import Flasher

      def create_flasher(baudrates, probe_methods, device):
          return Flasher(
              baudrates=baudrates.to_py(),
              probe_methods=probe_methods.to_py(),
              device=device,
          )

      create_flasher
    `)
            .callKwargs({
            baudrates: new Map([
                [
                    PyApplicationType.GECKO_BOOTLOADER,
                    this.manifest.baudrates.bootloader,
                ],
                [PyApplicationType.CPC, this.manifest.baudrates.cpc],
                [PyApplicationType.EZSP, this.manifest.baudrates.ezsp],
                [PyApplicationType.SPINEL, this.manifest.baudrates.spinel],
            ]),
            probe_methods: [
                PyApplicationType.GECKO_BOOTLOADER,
                PyApplicationType.CPC,
                PyApplicationType.EZSP,
                PyApplicationType.SPINEL,
            ],
            device: '/dev/webserial', // the device name is ignored
        });
        await this.detectRunningFirmware();
    }
    async detectRunningFirmware() {
        this.flashingStep = FlashingStep.PROBING;
        try {
            await this.pyFlasher.probe_app_type();
        }
        catch (e) {
            this.pyFlasher = undefined;
            this.serialPort = undefined;
            this.flashingStep = FlashingStep.PROBING_FAILED;
            return;
        }
        this.flashingStep = FlashingStep.PROBING_COMPLETE;
    }
    selectFirmware() {
        this.flashingStep = FlashingStep.SELECT_FIRMWARE;
    }
    onFirmwareLoaded(e) {
        this.selectedFirmware = e.detail.firmware;
    }
    async flashFirmware() {
        this.flashingStep = FlashingStep.INSTALLING;
        this.uploadProgress = 0;
        await this.pyFlasher.enter_bootloader();
        try {
            await this.pyFlasher.flash_firmware.callKwargs(this.selectedFirmware, {
                progress_callback: (current, total) => {
                    this.uploadProgress = current / total;
                },
            });
            this.flashingStep = FlashingStep.DONE;
        }
        catch (e) {
            this.flashingStep = FlashingStep.INSTALL_FAILED;
        }
    }
    async close() {
        if (this.serialPort) {
            await this.serialPort.close();
        }
        this.parentNode.removeChild(this);
    }
    showDebugLog() {
        const debugText = `data:text/plain;charset=utf-8,${encodeURIComponent(this.debugLog)}`;
        downloadFile(debugText, 'silabs_flasher.log');
    }
    formatHeadingText(text) {
        if (text.length < 20) {
            return text;
        }
        // FIXME: this moves the closing `x` out of the way
        return text + '\u00A0'.repeat(8);
    }
    simpleVersion(version) {
        if (!version) {
            return null;
        }
        return Array.from(version.components)
            .map((c) => c.data)
            .join('');
    }
    render() {
        let content = html ``;
        let headingText = 'Connecting';
        let showDebugLogButton = true;
        let showCloseButton = true;
        let hideActions = false;
        if (this.flashingStep === FlashingStep.SELECTING_PORT) {
            if (this.mwcDialog) {
                this.mwcDialog.open = false;
            }
            hideActions = true;
            showDebugLogButton = false;
            headingText = 'Select a serial port';
            content = html `<p>
        <p class="spinner"><mwc-circular-progress indeterminate density=8></mwc-circular-progress></p>
        <p>Plug in and select your ${this.manifest.product_name}</p>
      </p>`;
        }
        else if (this.flashingStep === FlashingStep.PORT_SELECTION_CANCELLED) {
            showDebugLogButton = false;
            headingText = 'Serial port was not selected';
            content = html `<p>
          If you didn't select a serial port because the
          ${this.manifest.product_name} was missing, make sure the USB port it's
          plugged into works and the ${this.manifest.product_name} is detected
          by your operating system.
        </p>
        <p>
          If you are using Windows or macOS, install the
          <a
            href="https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers?tab=downloads"
            target="_blank"
            rel="noreferrer noopener"
            >Silicon Labs CP2102 driver</a
          >.
        </p>

        <mwc-button slot="primaryAction" @click=${this.selectSerialPort}>
          Retry
        </mwc-button> `;
        }
        else if ([FlashingStep.LOADING_PYODIDE, FlashingStep.PROBING].includes(this.flashingStep)) {
            hideActions = true;
            showDebugLogButton = false;
            headingText = '';
            content = html `<p>
        <p class="spinner">
          <mwc-circular-progress
            density=8
            ?indeterminate=${this.pyodideLoadState === PyodideLoadState.LOADING_PYODIDE ||
                this.flashingStep === FlashingStep.PROBING}
            .progress=${this.pyodideLoadState / (2 * PyodideLoadState.READY)}
          >
          </mwc-circular-progress>
        </p>
        <p class="centered">
          Connecting...
          <br />
          This can take a few seconds.
        </p>
      </p>`;
        }
        else if (this.flashingStep === FlashingStep.PROBING_FAILED) {
            const isMacOS = navigator.userAgent.includes('Mac OS');
            const isUsingCP210x = this.manifest.usb_filters.find(filter => filter.vid == 4292 && filter.pid == 60000);
            headingText = 'Connection failed';
            content = html `${isMacOS && isUsingCP210x
                ? html `<section class="warning">
              <h2><usf-icon .icon=${mdiAlert}></usf-icon> macOS Driver Bug</h2>

              <p>
                The built-in drivers on macOS do not work properly with the
                ${this.manifest.product_name}. Install the updated
                <a
                  href="https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers?tab=downloads"
                  target="_blank"
                  rel="noreferrer noopener"
                  >Silicon Labs CP2102 driver</a
                >
                and re-connect to the serial port titled
                <strong
                  >CP210x USB to UART Bridge Controller
                  (cu.SLAB_USBtoUART)</strong
                >.
              </p>
            </section>`
                : ''}
        <p>The running firmware could not be detected.</p>

        <p>
          Make sure the USB port works and if you are using a USB extension
          cable, make sure the cable can transfer data. Unplug the
          ${this.manifest.product_name} and plug it back in to reset and try
          again.
        </p>

        <mwc-button slot="primaryAction" @click=${this.selectSerialPort}>
          Retry
        </mwc-button>`;
        }
        else if (this.flashingStep === FlashingStep.PROBING_COMPLETE) {
            hideActions = true;
            showDebugLogButton = false;
            headingText = this.manifest.product_name;
            const { Version } = this.pyodide.pyimport('universal_silabs_flasher.common');
            const appType = this.pyFlasher.app_type.value;
            const compatibleFirmwareType = ApplicationTypeToFirmwareType[appType];
            const compatibleFirmware = this.manifest.firmwares.find(fw => fw.type === compatibleFirmwareType &&
                Version(fw.version) > this.pyFlasher.app_version &&
                !Version(fw.version).compatible_with(this.pyFlasher.app_version));
            // Show a one-click "upgrade" button if possible
            let upgradeButton;
            if (compatibleFirmware) {
                upgradeButton = html `<mwc-button
          @click=${async () => {
                    const response = await fetch(compatibleFirmware.url);
                    const firmwareData = await response.arrayBuffer();
                    this.selectedFirmware = await parseFirmwareBuffer(this.pyodide, firmwareData);
                    this.flashFirmware();
                }}
        >
          <usf-icon .icon=${mdiShimmer}></usf-icon>
          Upgrade to &nbsp;<strong>${compatibleFirmware.version}</strong>
        </mwc-button>`;
            }
            content = html `
        <p>
          <table>
            <tbody>
              <tr>
                <td><usf-icon .icon=${mdiFirmware}></usf-icon></td>
                <td>${ApplicationNames[appType] || 'unknown'} ${this.simpleVersion(this.pyFlasher.app_version)}</td>
              </tr>
              <tr>
                <td><usf-icon .icon=${mdiChip}></usf-icon></td>
                <td>${this.manifest.product_name}</td>
              </tr>
            </tbody>
          </table>
        </p>

        <div id="firmwareInstallButtons">
          ${upgradeButton || ''}
          <mwc-button @click=${this.selectFirmware}>
            <usf-icon .icon=${mdiAutorenew}></usf-icon>
            Change firmware
          </mwc-button>
        </div>`;
        }
        else if (this.flashingStep === FlashingStep.SELECT_FIRMWARE) {
            headingText = this.manifest.product_name;
            content = html `
        <p>Select new firmware to install.</p>

        <firmware-selector
          .pyodide=${this.pyodide}
          .manifest=${this.manifest}
          @firmwareLoaded=${this.onFirmwareLoaded}
        ></firmware-selector>

        ${this.selectedFirmware
                ? html `<p class="firmware-metadata">${this.getFirmwareMetadata()}</p>`
                : ''}

        <mwc-button
          slot="primaryAction"
          @click=${this.flashFirmware}
          .disabled=${!this.selectedFirmware}
        >
          Install
        </mwc-button>
      `;
        }
        else if (this.flashingStep === FlashingStep.INSTALLING) {
            // Hide the close button to prevent it from being accidentally clicked during flashing.
            // The bootloader is resilient so nothing will actually break that can't be fixed by retrying.
            hideActions = true;
            showCloseButton = false;
            headingText = 'Installing firmware';
            content = html `
        <p>
          The new firmware is now installing. Do not disconnect the
          ${this.manifest.product_name} or close this browser window.
        </p>
        <p>
          <span class="progress-text"
            >Progress: ${(+this.uploadProgress * 100).toFixed(1)}%</span
          >
          <mwc-linear-progress
            .progress=${this.uploadProgress}
            ?indeterminate=${this.uploadProgress < 0.01}
          ></mwc-linear-progress>
        </p>
      `;
        }
        else if (this.flashingStep === FlashingStep.INSTALL_FAILED) {
            headingText = 'Installation failed';
            content = html `
        <p>
          Firmware installation failed. Unplug your
          ${this.manifest.product_name} and plug it back in to retry.
        </p>

        <mwc-button slot="primaryAction" @click=${this.selectSerialPort}>
          Retry
        </mwc-button>
      `;
        }
        else if (this.flashingStep === FlashingStep.DONE) {
            headingText = 'Installation success';
            content = html `
        <p>Firmware has been successfully installed.</p>

        <mwc-button slot="primaryAction" @click=${this.detectRunningFirmware}>
          Continue
        </mwc-button>
      `;
        }
        return html `
      <mwc-dialog
        heading="${this.formatHeadingText(headingText)}"
        scrimClickAction=""
        escapeKeyAction=""
        ?hideActions=${hideActions}
      >
        ${showCloseButton
            ? html `
              <usf-icon-button id="closeButton" dialogAction="close">
                <usf-icon .icon=${mdiClose}></usf-icon>
              </usf-icon-button>
            `
            : ''}
        ${content}
        ${showDebugLogButton
            ? html `
              <mwc-button slot="secondaryAction" @click=${this.showDebugLog}>
                Debug Log
              </mwc-button>
            `
            : ''}
      </mwc-dialog>
    `;
    }
};
FlashingDialog.styles = css `
    :host {
      --mdc-theme-primary: #03a9f4;
    }

    a {
      color: var(--mdc-theme-primary);
    }

    .metadata {
      font-size: 0.8em;
    }

    img {
      vertical-align: middle;
    }

    #closeButton {
      position: absolute;
      top: 10px;
      right: 10px;
    }

    p.spinner {
      text-align: center;
      font-size: 2em;
    }

    p.firmware-metadata {
      font-size: 0.8em;
      line-height: 1.2;
      overflow: auto;
    }

    span.progress-text {
      font-size: 0.8em;
    }

    mwc-button usf-icon {
      margin-right: 0.2em;
    }

    #firmwareInstallButtons {
      margin-left: -3px;

      text-align: left;
    }

    #firmwareInstallButtons mwc-button {
      display: block;
    }

    #firmwareInstallButtons mwc-button:not(:last-child) {
      margin-bottom: 0.3em;
    }

    .centered {
      text-align: center;
    }

    td usf-icon {
      vertical-align: bottom;
    }

    section.warning {
      background-color: hsl(38, 96%, 90%);

      font-size: 0.9em;

      margin-left: -24px;
      margin-right: -24px;

      padding-left: 24px;
      padding-right: 24px;
      padding-top: 12px;
      padding-bottom: 12px;
    }

    section.warning h2 usf-icon {
      vertical-align: text-bottom;
    }

    section.warning code {
      font-weight: bold;
    }
  `;
__decorate([
    state()
], FlashingDialog.prototype, "flashingStep", void 0);
__decorate([
    property()
], FlashingDialog.prototype, "pyodide", void 0);
__decorate([
    state()
], FlashingDialog.prototype, "pyodideLoadState", void 0);
__decorate([
    property()
], FlashingDialog.prototype, "manifest", void 0);
__decorate([
    state()
], FlashingDialog.prototype, "selectedFirmware", void 0);
__decorate([
    state()
], FlashingDialog.prototype, "serialPort", void 0);
__decorate([
    state()
], FlashingDialog.prototype, "uploadProgress", void 0);
__decorate([
    state()
], FlashingDialog.prototype, "progressState", void 0);
__decorate([
    query('mwc-dialog')
], FlashingDialog.prototype, "mwcDialog", void 0);
FlashingDialog = __decorate([
    customElement('flashing-dialog')
], FlashingDialog);
export { FlashingDialog };
