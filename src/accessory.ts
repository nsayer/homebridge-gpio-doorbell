import {
  AccessoryPlugin,
  API,
  Logger,
} from 'homebridge';
import storage from 'node-persist';
import {Rio} from 'rpi-io';
import {AccessoryConfig} from 'homebridge/lib/bridgeService';
import axios from 'axios';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class GpioDoorbellAccessory implements AccessoryPlugin {
  private storage;

  private informationService;
  private doorbellService;
  private muteCharacteristic;

  private lastRang?: number;

  private readonly doorbellMuteKey = 'homebridge-gpio-doorbell.mute';
  private doorbellMute: boolean;

  private button;
  private relay;

  constructor(
    public readonly log: Logger,
    public readonly config: AccessoryConfig,
    public readonly api: API,
  ) {
    this.log.debug('Homebridge GPIO Doorbell loaded.');

    // init storage
    const cacheDir = this.api.user.persistPath();
    this.storage = storage.create();
    this.storage.initSync({dir: cacheDir, forgiveParseErrors: true});

    // add accessory information
    this.informationService = new this.api.hap.Service.AccessoryInformation()
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Homebridge')
      .setCharacteristic(this.api.hap.Characteristic.Model, 'GPIO Doorbell');

    // create new doorbell accessory
    this.doorbellService = new this.api.hap.Service.Doorbell(this.config.name);

    // add characteristic ProgrammableSwitchEvent
    this.doorbellService.getCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent);

    // setup mute characteristic
    if (this.config.enableOutput) {
      this.muteCharacteristic = this.doorbellService.getCharacteristic(this.api.hap.Characteristic.Mute);
      this.muteCharacteristic.onGet(this.handleMuteGet.bind(this));
      this.muteCharacteristic.onSet(this.handleMuteSet.bind(this));
    }

    // restore persisted settings
    this.doorbellMute = this.storage.getItemSync(this.doorbellMuteKey) || false;
    this.storage.setItemSync(this.doorbellMuteKey, this.doorbellMute);
    this.doorbellService.updateCharacteristic(this.api.hap.Characteristic.Mute, this.doorbellMute as boolean);

    // setup gpio
    this.setupGpio();
  }

  getServices() {
    return [
      this.informationService,
      this.doorbellService,
    ];
  }

  setupGpio(): void {
    this.button = new Rio(this.config.gpioPin, "in");
    this.button.monitor("both", (event, date) => {this.handlePinChange(event); });

    if (this.config.enableOutput) {
      this.log.debug(`Enable output on pin ${this.config.outputGpioPin}`);

      this.relay = new Rio(this.config.outputGpioPin, "out");
      this.relay.set(0);
    }
  }

  /**
   * @param gpioPin
   * @param circuitOpen true when circuit is open, false if circuit is closed
   * @private
   */
  private async handlePinChange(direction: string): Promise<void> {
    this.log.debug(`Pin changed state to ${direction}.`);

    let buttonPushed = direction == "rising";

    if (this.config.negateInput) {
      buttonPushed = !buttonPushed;
    }

    // handle GPIO output
    if (this.config.enableOutput && !this.doorbellMute) {
      this.log.debug(`Setting GPIO pin ${this.config.outputGpioPin} to ${buttonPushed ? 'HIGH' : 'LOW'}`);
      this.relay.set(buttonPushed?1:0);
    }

    if (buttonPushed) {
      // handle throttle time
      const now = Date.now();
      if (this.lastRang && (this.lastRang + this.config.throttleTime) >= now) {
        this.log.debug(`Ignoring state change on pin because throttle time has not expired.`);
        return;
      } else {
        this.lastRang = Date.now();
      }

      // forward ring to homekit
      this.log.info(`Doorbell "${this.config.name}" rang.`);

      if (!this.config.enableHttpTrigger || !this.config.httpTriggerUrl) {
        // ring in homekit
        this.log.info('Forwarding ring directly to HomeKit.');
        this.doorbellService.updateCharacteristic(
          this.api.hap.Characteristic.ProgrammableSwitchEvent,
          this.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
        );
      } else {
        // ring via 3rd party plugin
        const url = this.config.httpTriggerUrl;
        this.log.info(`Performing request to webhook at ${url}.`);
        try {
          await axios.get(url);
        /* eslint-disable  @typescript-eslint/no-explicit-any */
        } catch (e: any) {
          if (e.response) {
            this.log.error(`Request to webhook failed with status code ${e.response.status}: ${e.response.data}`);
          } else {
            this.log.error(`Request to webhook failed with message: ${e?.message}`);
          }
        }
      }
    }
  }

  private handleMuteSet(value: boolean): void {
    this.log.debug(`Set mute to ${value}.`);

    this.doorbellMute = value;
    this.storage.setItemSync(this.doorbellMuteKey, this.doorbellMute);

    if (!this.doorbellMute && this.config.enableOutput) {
      this.relay.set(0);
    }
  }

  private handleMuteGet(): boolean {
    this.log.debug('Get mute.');
    return this.doorbellMute;
  }
}
